import type { PageSize } from '../../api/render';
import { DEFAULT_PAGE_SIZE } from '../../stores/pages';

/**
 * The geometry of the thumbnails list: a column of cells, each a thumbnail of one page over its page number. Pure functions and
 * one class, no DOM, no React: where every cell sits for a width, which cells meet a viewport, and where to scroll to bring one
 * into view. The list is virtualized (only the cells near the viewport are mounted), so everything is arithmetic on the page sizes.
 *
 * **Sizes.** Every thumbnail is as wide as the list allows (it follows the panel's width), as tall as its page's shape makes it,
 * so a placeholder has the right size before its first pixel is rendered. A page that is more than `MAX_THUMBNAIL_ASPECT` times
 * as tall as wide would otherwise take a whole screen: its thumbnail stops at that height and is narrower instead.
 *
 * **Cheap resizing.** The cell tops are `width * (sum of the aspects above) + index * (cell chrome + gap)`: the sums depend on the
 * page sizes only (`thumbnailMetricsFor`, built once per list of sizes), so dragging the panel's splitter changes one factor
 * and nothing is rebuilt.
 */

/** A thumbnail is at most this many times as tall as it is wide; a taller page is shown narrower. */
export const MAX_THUMBNAIL_ASPECT = 2;

/** The fixed parts of a cell in px (they come from the spacing tokens; `ThumbnailItem` has the classes that produce them). */
export interface ThumbnailSpacing {
  /** Padding of a cell around its thumbnail and label. */
  pad: number;
  /** Space between a thumbnail and its page number. */
  labelGap: number;
  /** Height of the page number's pill. */
  labelHeight: number;
  /** Space between two cells. */
  gap: number;
}

/** What the page sizes say about the list, independent of its width. */
export interface ThumbnailMetrics {
  readonly count: number;
  /** Height over width of each page. */
  readonly aspect: Float64Array;
  /** `aspectTop[i]` is the sum of the (clamped) aspects of the pages before page `i`; one entry more than there are pages. */
  readonly aspectTop: Float64Array;
}

const DEFAULT_ASPECT = DEFAULT_PAGE_SIZE[1] / DEFAULT_PAGE_SIZE[0];

/** The thumbnail's aspect (height over width) for a page's own: the same, at most `MAX_THUMBNAIL_ASPECT`. */
function clampedAspect(aspect: number): number {
  return Math.min(aspect, MAX_THUMBNAIL_ASPECT);
}

function aspectOf(size: PageSize | undefined): number {
  const width = size?.[0] ?? 0;
  const height = size?.[1] ?? 0;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? height / width : DEFAULT_ASPECT;
}

export function buildThumbnailMetrics(sizes: readonly PageSize[]): ThumbnailMetrics {
  const count = sizes.length;
  const aspect = new Float64Array(count);
  const aspectTop = new Float64Array(count + 1);
  for (let page = 0; page < count; page += 1) {
    const own = aspectOf(sizes[page]);
    aspect[page] = own;
    aspectTop[page + 1] = (aspectTop[page] ?? 0) + clampedAspect(own);
  }
  return { count, aspect, aspectTop };
}

const metricsCache = new WeakMap<readonly PageSize[], ThumbnailMetrics>();

/** `buildThumbnailMetrics`, remembered per list of sizes (which is never edited, only replaced). */
export function thumbnailMetricsFor(sizes: readonly PageSize[]): ThumbnailMetrics {
  let metrics = metricsCache.get(sizes);
  if (metrics === undefined) {
    metrics = buildThumbnailMetrics(sizes);
    metricsCache.set(sizes, metrics);
  }
  return metrics;
}

/** A place in the list that survives a change of width: a cell and how far down it the place is (0 to 1). */
export interface ListAnchor {
  index: number;
  fraction: number;
}

/** First and last cell of a range, inclusive. */
export interface IndexRange {
  first: number;
  last: number;
}

/** A thumbnail's size in px. */
export interface ThumbnailSize {
  width: number;
  height: number;
}

/**
 * The layout of the list at one width. `width` is the width a thumbnail may have; a cell is `2 * pad` wider. Immutable: a change of
 * width or of the page sizes makes a new one, which costs nothing (the metrics are shared).
 */
export class ThumbnailLayout {
  readonly count: number;
  readonly width: number;
  /** The height of the whole list in px (0 without pages). */
  readonly height: number;
  private readonly chrome: number;
  private readonly stride: number;

  constructor(
    private readonly metrics: ThumbnailMetrics,
    width: number,
    spacing: ThumbnailSpacing,
  ) {
    this.count = metrics.count;
    this.width = Math.max(0, Number.isFinite(width) ? width : 0);
    this.chrome = 2 * spacing.pad + spacing.labelGap + spacing.labelHeight;
    this.stride = this.chrome + spacing.gap;
    this.height =
      this.count === 0 ? 0 : this.width * (metrics.aspectTop[this.count] ?? 0) + this.count * this.stride - spacing.gap;
  }

  /** Where the cell of `index` starts, in px from the top of the list. */
  top(index: number): number {
    return this.width * (this.metrics.aspectTop[index] ?? 0) + index * this.stride;
  }

  cellHeight(index: number): number {
    return this.width * clampedAspect(this.metrics.aspect[index] ?? DEFAULT_ASPECT) + this.chrome;
  }

  bottom(index: number): number {
    return this.top(index) + this.cellHeight(index);
  }

  /** The size of the thumbnail of `index`: as wide as allowed, or narrower where the page is too tall for that. */
  thumbnailSize(index: number): ThumbnailSize {
    const aspect = this.metrics.aspect[index] ?? DEFAULT_ASPECT;
    const height = this.width * clampedAspect(aspect);
    return { width: aspect > MAX_THUMBNAIL_ASPECT ? height / aspect : this.width, height };
  }

  /** The cell at `y` (px in the list): the one that contains it, the one above it when `y` is between two, the nearest end otherwise. */
  indexAt(y: number): number {
    if (this.count === 0) return 0;
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.top(middle) <= y) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** The cells that meet `[top, bottom)` of the list, first to last inclusive; `null` if none does. */
  itemsIn(top: number, bottom: number): IndexRange | null {
    if (this.count === 0 || !(bottom > top)) return null;
    // The first cell that ends below `top`.
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.bottom(middle) > top) high = middle;
      else low = middle + 1;
    }
    const first = low;
    // The first cell that starts at or below `bottom`.
    high = this.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.top(middle) < bottom) low = middle + 1;
      else high = middle;
    }
    const last = low - 1;
    return first <= last ? { first, last } : null;
  }

  /** The place in the list at `y`, as an anchor that can be found again at another width. */
  anchorAt(y: number): ListAnchor {
    const index = this.indexAt(y);
    const fraction = (y - this.top(index)) / this.cellHeight(index);
    return { index, fraction: Math.min(1, Math.max(0, fraction)) };
  }

  /** Where `anchor` is now, in px from the top of the list. */
  positionOf(anchor: ListAnchor): number {
    const index = Math.min(Math.max(0, anchor.index), Math.max(0, this.count - 1));
    return this.top(index) + anchor.fraction * this.cellHeight(index);
  }

  /**
   * Where the viewport has to be (the list's px at its top) for the cell of `index` to show, or `null` if it shows whole already
   * and nothing has to move. `margin` is left free around the cell when it is put at an edge (room for its focus ring).
   *
   * A cell that is near (less than a viewport away) is brought in at the nearest edge, so following a page by page does not
   * jump; a cell that is far away is centered, so a jump shows it with its neighbours. A cell taller than the viewport is
   * shown from its top. The result is kept inside the list.
   */
  reveal(index: number, viewTop: number, viewHeight: number, margin = 0): number | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.count || !(viewHeight > 0)) return null;
    const top = this.top(index);
    const bottom = top + this.cellHeight(index);
    const viewBottom = viewTop + viewHeight;
    if (top >= viewTop && bottom <= viewBottom) return null;
    const size = bottom - top;
    const distance = bottom <= viewTop ? viewTop - bottom : top >= viewBottom ? top - viewBottom : 0;
    let target: number;
    if (size + 2 * margin > viewHeight) target = top - margin;
    else if (distance >= viewHeight) target = top - (viewHeight - size) / 2;
    else if (top < viewTop) target = top - margin;
    else target = bottom + margin - viewHeight;
    const least = -margin;
    const most = Math.max(least, this.height + margin - viewHeight);
    target = Math.min(most, Math.max(least, target));
    return Math.abs(target - viewTop) < 0.5 ? null : target;
  }

  /**
   * The cell PageDown (`direction` 1) or PageUp (-1) moves to from `index`: as many cells on as fit in `viewHeight`, and at
   * least one. Stays at the ends.
   */
  pageTarget(index: number, direction: 1 | -1, viewHeight: number): number {
    if (this.count === 0) return 0;
    const from = Math.min(Math.max(0, index), this.count - 1);
    const y = this.top(from) + direction * Math.max(0, viewHeight);
    const at = this.indexAt(y);
    // Down: the cell that contains the position. Up: the first cell that starts at or below it, so both go as far.
    const reach = direction === 1 ? at : this.top(at) < y ? at + 1 : at;
    return direction === 1
      ? Math.min(this.count - 1, Math.max(reach, from + 1))
      : Math.max(0, Math.min(reach, from - 1));
  }
}
