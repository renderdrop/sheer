import type { TextLineInfo } from '../../api/textEdit';
import type { Rect } from '../../api/wire';
import { MINIBAR_GAP, MINIBAR_INSET, type Box, type Placement } from '../minibar/placement';
import type { Align } from './lines';

/** A bar covering more than this share of other text is "dense": it must not sit there (DESIGN 3.10 E3, designer v1.5.0). */
export const DENSE_SHARE = 0.02;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const area = (b: Box): number => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);

function overlap(a: Box, b: Box): number {
  return area({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
}

/** Share of the bar's area that lies over `obstacles` (they may overlap each other: the sum is capped at 1). */
export function coverage(bar: Box, obstacles: readonly Box[]): number {
  const total = area(bar);
  if (total <= 0) return 0;
  return Math.min(1, obstacles.reduce((sum, o) => sum + overlap(bar, o), 0) / total);
}

/**
 * Where the edit bar goes (DESIGN 3.3, 3.10 E3): aligned to the start of the box (or paragraph rule), above it, 8 px away; below it
 * when the text above is dense and the text below is clear, or when above does not fit; docked when neither fits or both cover text
 * (`canDock`; without a dock row the freer side wins). It never overlaps `selection` (the box and the rule), because it sits a gap
 * away vertically.
 */
export function placeEditBar(
  selection: Box,
  bar: { width: number; height: number },
  bounds: Box,
  obstacles: readonly Box[],
  canDock = true,
): Placement {
  const minLeft = bounds.left + MINIBAR_INSET;
  const maxLeft = bounds.right - MINIBAR_INSET - bar.width;
  const left = maxLeft < minLeft ? minLeft : clamp(selection.left, minLeft, maxLeft);
  const above = selection.top - MINIBAR_GAP - bar.height;
  const below = selection.bottom + MINIBAR_GAP;
  const fitsAbove = above >= bounds.top + MINIBAR_INSET;
  const fitsBelow = below + bar.height <= bounds.bottom - MINIBAR_INSET;
  const at = (top: number): Box => ({ left, top, right: left + bar.width, bottom: top + bar.height });
  if (fitsAbove && fitsBelow) {
    const up = coverage(at(above), obstacles);
    if (up <= DENSE_SHARE) return { mode: 'above', left, top: above };
    const down = coverage(at(below), obstacles);
    if (down <= DENSE_SHARE) return { mode: 'below', left, top: below };
    if (canDock) return { mode: 'dock' };
    return down < up ? { mode: 'below', left, top: below } : { mode: 'above', left, top: above };
  }
  if (fitsAbove) return { mode: 'above', left, top: above };
  if (fitsBelow) return { mode: 'below', left, top: below };
  return { mode: 'dock' };
}

/**
 * The other lines of the page in client pixels, derived from the edit box itself (its client rect and its page-space line box).
 * Assumes an unrotated view; a rotated page only makes the dense-side choice less informed.
 */
export function obstaclesOf(lines: readonly TextLineInfo[], line: TextLineInfo, anchor: Rect, align: Align): Box[] {
  const { box } = line;
  if (box.h <= 0 || anchor.h <= 0) return [];
  const s = anchor.h / box.h;
  const originY = anchor.y - box.y * s;
  const originX =
    align === 'right'
      ? anchor.x + anchor.w - (box.x + box.w) * s
      : align === 'center'
        ? anchor.x + anchor.w / 2 - (box.x + box.w / 2) * s
        : anchor.x - box.x * s;
  return lines
    .filter((l) => l.key.line !== line.key.line)
    .map((l) => ({
      left: originX + l.box.x * s,
      top: originY + l.box.y * s,
      right: originX + (l.box.x + l.box.w) * s,
      bottom: originY + (l.box.y + l.box.h) * s,
    }));
}
