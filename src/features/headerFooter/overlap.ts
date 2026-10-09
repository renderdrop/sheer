import { HF_BACKGROUND_PAD, type DetectedItem, type PlacedRun } from '../../api/headerFooter';
import type { Rect } from '../../api/wire';

/**
 * Where a new header or footer would sit against what the document already has (F19.12). Pure geometry in page space (points, top
 * left of the unrotated page, y down): the box of a run is the Helvetica text box (ascender above, descender below the baseline),
 * turned by the run's angle like the file writer turns it; with a background the box is the one the writer fills (`backgroundRect`).
 */

/** The distance from the baseline to the top of the text, and to its bottom, in em (the backend's `ASCENT` and `DESCENT`). */
const ASCENT = 0.72;
const DESCENT = 0.21;
/** The full glyph box of Helvetica in em, which the background box covers before its padding (the backend's `BOX_ASCENT`, `BOX_DESCENT`). */
const BOX_ASCENT = 0.931;
const BOX_DESCENT = 0.225;
/** Boxes that touch or overlap by less than this many points do not count. */
const TOLERANCE = 0.5;

/** The bounding box of `run` in page space, `pad` points larger on every side. */
export function runRect(run: PlacedRun, pad = 0): Rect {
  return extentRect(run, DESCENT, ASCENT, pad);
}

/**
 * The opaque box in the page colour the writer fills behind `run` when the background is on (F21.7, the backend's `background_rect`):
 * the run's full glyph box plus `HF_BACKGROUND_PAD` on every side, in page space.
 */
export function backgroundRect(run: PlacedRun): Rect {
  return extentRect(run, BOX_DESCENT, BOX_ASCENT, HF_BACKGROUND_PAD);
}

function extentRect(run: PlacedRun, below: number, above: number, pad: number): Rect {
  const radians = (run.angle * Math.PI) / 180;
  const dir = { x: Math.cos(radians), y: -Math.sin(radians) };
  const up = { x: -Math.sin(radians), y: -Math.cos(radians) };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of [-pad, run.width + pad]) {
    for (const t of [-(below * run.size + pad), above * run.size + pad]) {
      xs.push(run.origin.x + s * dir.x + t * up.x);
      ys.push(run.origin.y + s * dir.y + t * up.y);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > TOLERANCE &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > TOLERANCE
  );
}

export interface Overlap {
  item: DetectedItem;
  run: PlacedRun;
}

/** The pairs of a new run and an existing piece whose boxes overlap; with `background` on, the run's box is the background box. */
export function findOverlaps(
  runs: readonly PlacedRun[],
  items: readonly DetectedItem[],
  background: boolean,
): Overlap[] {
  const found: Overlap[] = [];
  for (const run of runs) {
    const box = background ? backgroundRect(run) : runRect(run);
    for (const item of items) {
      if (rectsOverlap(box, item.rect)) found.push({ item, run });
    }
  }
  return found;
}

/** The existing pieces that at least one run overlaps, each once, in the order detected. */
export function overlappedItems(overlaps: readonly Overlap[]): DetectedItem[] {
  const seen = new Set<DetectedItem>();
  for (const { item } of overlaps) seen.add(item);
  return [...seen];
}
