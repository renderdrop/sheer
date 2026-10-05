import { tokenPx } from '../../components/tokens';
import type { PageSize } from '../../api/render';
import { boxToView, type Box, type Rotation } from '../viewer/transform';

/**
 * The geometry of the comment margin (DESIGN 3.5 B9). Pure: where the column is, how wide, where each bubble sits. The column is
 * 240 px, 16 px from the page; below 360 px of free page width it is 32 px of avatar markers; bubbles stack 8 px apart.
 */
export interface MarginMetrics {
  gap: number;
  width: number;
  compact: number;
  stack: number;
  freeMin: number;
  marker: number;
}

export const MARGIN_FALLBACK: MarginMetrics = { gap: 16, width: 240, compact: 32, stack: 8, freeMin: 360, marker: 24 };

let cached: MarginMetrics | null = null;

/** The sizes from the tokens (`--margin-*`), read once. */
export function marginMetrics(): MarginMetrics {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return MARGIN_FALLBACK;
  cached = {
    gap: tokenPx('--margin-gap', MARGIN_FALLBACK.gap),
    width: tokenPx('--margin-width', MARGIN_FALLBACK.width),
    compact: tokenPx('--margin-width-compact', MARGIN_FALLBACK.compact),
    stack: tokenPx('--margin-stack-gap', MARGIN_FALLBACK.stack),
    freeMin: tokenPx('--margin-free-min', MARGIN_FALLBACK.freeMin),
    marker: tokenPx('--margin-marker', MARGIN_FALLBACK.marker),
  };
  return cached;
}

export type MarginMode = 'off' | 'full' | 'compact';

export interface MarginSlot {
  mode: MarginMode;
  /** Pixels taken from the canvas width: the gap and the column (0 when off). Fit widths subtract it. */
  reserve: number;
  /** The width of the column itself. */
  column: number;
}

/**
 * The slot the margin takes in a canvas whose content box is `canvasWidth` wide (the scroll region without its padding, so
 * "canvas width - 48" of the spec). Full: gap + 240 = 256. When what is left for the page, `canvasWidth - 256`, is under 360 the
 * column is compact: gap + 32.
 */
export function marginSlot(
  canvasWidth: number,
  enabled: boolean,
  metrics: MarginMetrics = marginMetrics(),
  pageWidth?: number,
): MarginSlot {
  if (!enabled) return { mode: 'off', reserve: 0, column: 0 };
  const full = metrics.gap + metrics.width;
  // Too little room for a page, or no room beside the page (at the zoom it has) for the whole column: markers, never a clipped bubble.
  const crowded = pageWidth !== undefined && canvasWidth - pageWidth < full - 1;
  if (canvasWidth - full < metrics.freeMin || crowded) {
    return { mode: 'compact', reserve: metrics.gap + metrics.compact, column: metrics.compact };
  }
  return { mode: 'full', reserve: full, column: metrics.width };
}

export interface BubbleItem {
  /** The top of the anchor in the content, px. */
  anchor: number;
  /** The measured (or estimated) height of the bubble, px. */
  height: number;
}

/**
 * The tops of the bubbles, which come in document order (page, then anchor y). Each top is the larger of its anchor and the
 * previous bottom plus `gap`. A `pinned` bubble (the selected or focused one) is put at its anchor first and the others restack:
 * the ones after it downwards, the ones before it upwards.
 */
export function placeBubbles(items: readonly BubbleItem[], gap: number, pinned: number | null = null): number[] {
  const tops = new Array<number>(items.length).fill(0);
  const start = pinned !== null && pinned >= 0 && pinned < items.length ? pinned : 0;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = start; i < items.length; i += 1) {
    const item = items[i] as BubbleItem;
    const top = i === start ? item.anchor : Math.max(item.anchor, bottom + gap);
    tops[i] = top;
    bottom = top + item.height;
  }
  let above = start < items.length ? (tops[start] as number) : 0;
  for (let i = start - 1; i >= 0; i -= 1) {
    const item = items[i] as BubbleItem;
    const top = Math.min(item.anchor, above - gap - item.height);
    tops[i] = top;
    above = top;
  }
  return tops;
}

/** The indices of the bubbles that meet `[from, to]` (content px), given their tops and heights. */
export function visibleBubbles(
  tops: readonly number[],
  heights: readonly number[],
  from: number,
  to: number,
): number[] {
  const shown: number[] = [];
  for (let i = 0; i < tops.length; i += 1) {
    const top = tops[i] as number;
    if (top <= to && top + (heights[i] as number) >= from) shown.push(i);
  }
  return shown;
}

/**
 * The left edge of the column in the content: the right edge of the widest page plus the gap. `contentWidth` is the layout's own width
 * (the pages' box, the margin slot excluded), which centres each page.
 */
export function columnLeft(contentWidth: number, widestPagePx: number, gap: number): number {
  return (contentWidth + widestPagePx) / 2 + gap;
}

/** The date of a bubble: "Today 14:05" for today, else the short date. `''` for a date that cannot be read. */
export function bubbleDate(time: number | null, locale: string, now: number): string {
  if (time === null) return '';
  try {
    const when = new Date(time);
    const today = new Date(now);
    if (when.toDateString() === today.toDateString()) {
      const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day');
      const label = word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
      return `${label} ${new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(when)}`;
    }
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(when);
  } catch {
    return '';
  }
}

/** The initial of an author for the avatar; `''` when there is no name (the avatar then shows the user icon). */
export function initialOf(author: string | null): string {
  const name = (author ?? '').trim();
  const first = [...name][0];
  return first === undefined ? '' : first.toLocaleUpperCase();
}

/**
 * Where a comment's anchor is in the content: its top and its right edge. `page` is the page's size as drawn (unrotated), `rect` the
 * annotation's box in page space (`null` before its page is read: the anchor is then the top of the page).
 */
export function anchorOf(
  box: { left: number; top: number },
  scale: number,
  rect: Box | null,
  page: PageSize,
  rotation: Rotation,
): { top: number; right: number } {
  if (rect === null) return { top: box.top, right: box.left };
  const view = boxToView(rect, page, rotation);
  return { top: box.top + view.y * scale, right: box.left + (view.x + view.w) * scale };
}
