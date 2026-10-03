import type { Hit } from './store';

/**
 * The rows of the hit list (DESIGN 3.16): a page header (24 px) before the hits of each page, then a row (48 px) per hit. The heights
 * are fixed, so the list is virtualized by arithmetic alone (DESIGN 3.15).
 */
export type Row = { kind: 'page'; page: number } | { kind: 'hit'; hit: number };

export interface Rows {
  rows: readonly Row[];
  /** `tops[i]` is the top of row `i` in px; one more entry than there are rows, the last being the total height. */
  tops: Float64Array;
  /** The row of each hit, by the hit's index. */
  rowOfHit: Int32Array;
}

/** Builds the rows from the hits in the order of the document (pages ascending). */
export function buildRows(hits: readonly Hit[], pageRowHeight: number, hitRowHeight: number): Rows {
  const rows: Row[] = [];
  const rowOfHit = new Int32Array(hits.length);
  let page = -1;
  for (const hit of hits) {
    if (hit.page !== page) {
      page = hit.page;
      rows.push({ kind: 'page', page });
    }
    rowOfHit[hit.index] = rows.length;
    rows.push({ kind: 'hit', hit: hit.index });
  }
  const tops = new Float64Array(rows.length + 1);
  rows.forEach((row, i) => {
    tops[i + 1] = (tops[i] ?? 0) + (row.kind === 'page' ? pageRowHeight : hitRowHeight);
  });
  return { rows, tops, rowOfHit };
}

/** The rows to mount for a viewport: those that meet it, `overscan` more on each side. `null` for an empty list. */
export function rowRange(
  tops: Float64Array,
  scrollTop: number,
  viewHeight: number,
  overscan: number,
): { first: number; last: number } | null {
  const count = tops.length - 1;
  if (count <= 0) return null;
  // The first row whose bottom is below the top of the viewport.
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tops[middle + 1] ?? 0) > scrollTop) high = middle;
    else low = middle + 1;
  }
  const first = Math.min(low, count - 1);
  let end = first;
  while (end < count - 1 && (tops[end + 1] ?? 0) < scrollTop + viewHeight) end += 1;
  return { first: Math.max(0, first - overscan), last: Math.min(count - 1, end + overscan) };
}
