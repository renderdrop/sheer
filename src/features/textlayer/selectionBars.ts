import type { Rect } from '../../api/wire';
import { quadsForOffsets, type TextBoxes } from '../annotations/create/markup';

/**
 * The look of a text selection (F19.9): one continuous bar per line, the same geometry as the highlight tool's preview
 * (`quadsForOffsets`: the union of a line's glyph boxes, merged across word gaps), and with the gaps and overlaps between
 * lines closed so that a block of lines reads as one tinted block. Page space (points, before `/Rotate`), so a rotated page
 * needs nothing extra: the overlay is turned as a whole.
 */

/** A vertical gap or overlap up to this share of the taller bar is closed; a larger one is a paragraph break and stays. */
const CLOSE_SHARE = 0.75;

const overlapsHorizontally = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w;

/** Closes the vertical gaps between, and the overlaps of, bars that sit one above the other (meeting at the midpoint). */
export function closeLineGaps(bars: readonly Rect[]): Rect[] {
  const out = bars.map((bar) => ({ ...bar }));
  const order = out.map((_, i) => i).sort((a, b) => (out[a]?.y ?? 0) - (out[b]?.y ?? 0));
  for (let k = 0; k + 1 < order.length; k += 1) {
    const upper = out[order[k] ?? 0];
    const lower = out[order[k + 1] ?? 0];
    if (upper === undefined || lower === undefined || !overlapsHorizontally(upper, lower)) continue;
    const gap = lower.y - (upper.y + upper.h);
    if (Math.abs(gap) > CLOSE_SHARE * Math.max(upper.h, lower.h)) continue;
    const meet = upper.y + upper.h + gap / 2;
    upper.h = meet - upper.y;
    lower.h = lower.y + lower.h - meet;
    lower.y = meet;
  }
  return out;
}

/** The bars of the text between two offsets (end exclusive) of one page: one rectangle per line. */
export function selectionBars(layer: TextBoxes, start: number, end: number): Rect[] {
  const bars = quadsForOffsets(layer, start, end).map((q): Rect => {
    const [tl, , , br] = q;
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  });
  return closeLineGaps(bars);
}
