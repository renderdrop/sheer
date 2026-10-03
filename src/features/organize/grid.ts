/**
 * The geometry of the organize grid (DESIGN 3.28): square thumbnail boxes in rows, virtualized by row. Pure arithmetic, no DOM,
 * no React: where a cell sits for a width and a thumbnail size, which cells meet a viewport, where a pointer would insert, and
 * what the keys move. All sizes are px read from the tokens by the caller (`GridSpacing`).
 */

/** The fixed parts of the grid in px: `padding` of the scroller and `gap` between cells (24), a cell's own `pad` (4) and label. */
export interface GridSpacing {
  padding: number;
  gap: number;
  cellPad: number;
  labelGap: number;
  labelHeight: number;
}

export const GRID_THUMB = { min: 96, max: 256, step: 32, default: 160 } as const;

export interface GridMetrics {
  thumb: number;
  spacing: GridSpacing;
  cols: number;
  cellWidth: number;
  cellHeight: number;
  /** Distance between the left edges of two neighbours and between the tops of two rows. */
  stepX: number;
  stepY: number;
  /** Where the first column starts, so that the columns sit in the middle of a wide grid. */
  left: number;
}

/** `value` within the thumbnail range, snapped to the step; anything that is not a number gives the default. */
export function clampThumb(value: number): number {
  if (!Number.isFinite(value)) return GRID_THUMB.default;
  const snapped = GRID_THUMB.min + Math.round((value - GRID_THUMB.min) / GRID_THUMB.step) * GRID_THUMB.step;
  return Math.min(GRID_THUMB.max, Math.max(GRID_THUMB.min, snapped));
}

/** The metrics for a scroller whose content box is `width` px wide. At least one column, however narrow. */
export function gridMetrics(width: number, thumb: number, spacing: GridSpacing): GridMetrics {
  const cellWidth = thumb + 2 * spacing.cellPad;
  const cellHeight = thumb + spacing.labelGap + spacing.labelHeight + 2 * spacing.cellPad;
  const stepX = cellWidth + spacing.gap;
  const available = Math.max(0, width - 2 * spacing.padding);
  const cols = Math.max(1, Math.floor((available + spacing.gap) / stepX));
  const left = spacing.padding;
  return { thumb, spacing, cols, cellWidth, cellHeight, stepX, stepY: cellHeight + spacing.gap, left };
}

export function rowsOf(m: GridMetrics, count: number): number {
  return Math.ceil(count / m.cols);
}

/** The height of the scrolled content. */
export function contentHeight(m: GridMetrics, count: number): number {
  const rows = rowsOf(m, count);
  return rows === 0 ? 0 : 2 * m.spacing.padding + rows * m.cellHeight + (rows - 1) * m.spacing.gap;
}

export function rowOf(m: GridMetrics, index: number): number {
  return Math.floor(index / m.cols);
}

export function colOf(m: GridMetrics, index: number): number {
  return index % m.cols;
}

/** The top-left corner of the cell of `index` in content coordinates. */
export function cellOrigin(m: GridMetrics, index: number): { left: number; top: number } {
  return { left: m.left + colOf(m, index) * m.stepX, top: m.spacing.padding + rowOf(m, index) * m.stepY };
}

export interface IndexRange {
  first: number;
  last: number;
}

/** The cells in the rows that meet `[top, top + height)` (content coordinates), `overscanRows` more on each side. `null`: none. */
export function visibleRange(
  m: GridMetrics,
  count: number,
  top: number,
  height: number,
  overscanRows = 1,
): IndexRange | null {
  if (count === 0 || height <= 0) return null;
  const rows = rowsOf(m, count);
  const firstRow = Math.floor((top - m.spacing.padding) / m.stepY) - overscanRows;
  const lastRow = Math.floor((top + height - m.spacing.padding) / m.stepY) + overscanRows;
  const from = Math.min(rows - 1, Math.max(0, firstRow));
  const to = Math.min(rows - 1, Math.max(0, lastRow));
  return { first: from * m.cols, last: Math.min(count - 1, (to + 1) * m.cols - 1) };
}

/** The scroll position that brings the row of `index` fully into view, or `null` when it is in view already. */
export function revealTop(m: GridMetrics, index: number, scrollTop: number, viewHeight: number): number | null {
  const top = cellOrigin(m, index).top - m.spacing.gap;
  const bottom = cellOrigin(m, index).top + m.cellHeight + m.spacing.gap;
  if (top < scrollTop) return Math.max(0, top);
  if (bottom > scrollTop + viewHeight) return Math.max(0, bottom - viewHeight);
  return null;
}

/** A place between two cells where a drop would insert. */
export interface Insertion {
  /** The index in the list as it is now: the dragged pages go before the page that has it. `count` = at the end. */
  index: number;
  row: number;
  /** The gap in the row, 0 = before its first cell. */
  col: number;
}

/** The insertion nearest to a point (content coordinates): the nearest gap of the nearest row. */
export function insertionAt(m: GridMetrics, count: number, x: number, y: number): Insertion {
  const rows = rowsOf(m, count);
  if (rows === 0) return { index: 0, row: 0, col: 0 };
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y - m.spacing.padding + m.spacing.gap / 2) / m.stepY)));
  const inRow = Math.min(m.cols, count - row * m.cols);
  const col = Math.min(inRow, Math.max(0, Math.round((x - m.left + m.spacing.gap / 2) / m.stepX)));
  return { index: row * m.cols + col, row, col };
}

/** The marker's rectangle for an insertion (content coordinates), `width` px wide and as tall as a cell. */
export function markerRect(
  m: GridMetrics,
  insertion: Insertion,
  width: number,
): { left: number; top: number; height: number } {
  const left = m.left + insertion.col * m.stepX - m.spacing.gap / 2 - width / 2;
  return { left, top: m.spacing.padding + insertion.row * m.stepY, height: m.cellHeight };
}

/**
 * The `toIndex` of a move command for dropping `moved` (indices of the current list) at `insertion` (an index of the current list):
 * the backend counts in the list without the moved pages.
 */
export function toIndexFor(moved: readonly number[], insertion: number): number {
  let before = 0;
  for (const index of moved) if (index < insertion) before += 1;
  return insertion - before;
}

/** Whether moving `moved` to `toIndex` leaves the list as it is (the moved pages are one run that starts there). */
export function isNoopMove(moved: readonly number[], toIndex: number): boolean {
  const sorted = [...moved].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) return true;
  const run = sorted.every((index, i) => index === first + i);
  return run && toIndex === first;
}

/**
 * Where Alt+arrow puts the selection: `delta` positions (negative = earlier) from where it starts, as a `toIndex` in the list without
 * the moved pages; `null` when it would not move (at an end).
 */
export function keyboardMove(moved: readonly number[], count: number, delta: number): { toIndex: number } | null {
  const sorted = [...moved].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined || delta === 0) return null;
  // Pages before the first moved one are all kept: that is where the moved run starts in the list without them.
  const start = first;
  const remaining = count - sorted.length;
  const toIndex = Math.min(remaining, Math.max(0, start + delta));
  // A scattered selection gathers at the first one's place on a step; only an unchanged position is not a move.
  return isNoopMove(sorted, toIndex) ? null : { toIndex };
}

/** The selection after a click: plain selects one, primary toggles, Shift selects the run from the anchor. */
export function selectByClick(
  order: readonly number[],
  selected: readonly number[],
  anchor: number | null,
  id: number,
  mods: { toggle: boolean; range: boolean },
): { selected: number[]; anchor: number } {
  if (mods.range && anchor !== null) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      // Shift with primary adds the run; Shift alone replaces the selection with it.
      const merged = mods.toggle ? [...new Set([...selected, ...run])] : run;
      return { selected: merged, anchor };
    }
  }
  if (mods.toggle) {
    return { selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id], anchor: id };
  }
  return { selected: [id], anchor: id };
}

/** The index the arrow `key` goes to from `index`: left and right by one, up and down by a row; `null` at an edge. */
export function arrowTarget(m: GridMetrics, count: number, index: number, key: string): number | null {
  let next: number;
  switch (key) {
    case 'ArrowLeft':
      next = index - 1;
      break;
    case 'ArrowRight':
      next = index + 1;
      break;
    case 'ArrowUp':
      next = index - m.cols;
      break;
    case 'ArrowDown':
      // The row below may be shorter: the last cell is the nearest.
      next = index + m.cols < count ? index + m.cols : rowOf(m, index) < rowOf(m, count - 1) ? count - 1 : index;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  return next < 0 || next >= count || next === index ? null : next;
}

/** The indices of the cells whose boxes meet the rectangle (content coordinates): the marquee's selection. */
export function cellsInRect(
  m: GridMetrics,
  count: number,
  rect: { left: number; top: number; right: number; bottom: number },
): number[] {
  const hits: number[] = [];
  const firstRow = Math.max(0, Math.floor((rect.top - m.spacing.padding) / m.stepY));
  const lastRow = Math.min(rowsOf(m, count) - 1, Math.floor((rect.bottom - m.spacing.padding) / m.stepY));
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = 0; col < m.cols; col += 1) {
      const index = row * m.cols + col;
      if (index >= count) break;
      const { left, top } = cellOrigin(m, index);
      if (left < rect.right && left + m.cellWidth > rect.left && top < rect.bottom && top + m.cellHeight > rect.top) {
        hits.push(index);
      }
    }
  }
  return hits;
}
