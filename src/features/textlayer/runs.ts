import type { TextLayer } from '../../api/text';

/**
 * One text run (DESIGN 3.17): a stretch of characters on one line, read in content order, that becomes one transparent span.
 * The page's `get_text_layer` has a box per UTF-16 code unit; a run is built from them here, so the DOM has one node per run and
 * never one per glyph. All numbers are page space (points, before `/Rotate`).
 */
export interface Run {
  /** UTF-16 offsets into the layer's text: `[start, end)`. */
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  /** The extent of the run's boxes. Never below `MIN_RUN_SIDE_PT`, so a degenerate box still has a span. */
  w: number;
  h: number;
}

/** The smallest side a run has, in points. */
export const MIN_RUN_SIDE_PT = 1;
/** Most code units in one run: a run is a line fragment, and a long line is cut so that no span is huge. */
export const MAX_RUN_UNITS = 256;
/** A character farther from the one before than this many heights (a column gap, a tab stop) starts a new run. */
const GAP_IN_HEIGHTS = 1.5;
/** A character that starts this many heights before the end of the one before is on another line or another word block. */
const BACKSTEP_IN_HEIGHTS = 0.5;
/** A character whose vertical middle is farther than this share of the run's height from the run's middle starts a new run. */
const LINE_SHARE = 0.5;

const isBreak = (code: number) => code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

/** Builds the runs of a layer. A layer's `\r\n` line breaks, which have no area, end a run and are in no run. */
export function buildRuns(layer: Pick<TextLayer, 'text' | 'boxes'>): Run[] {
  const { text, boxes } = layer;
  const runs: Run[] = [];
  let start = -1;
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  let lastX = 0;
  let lastY = 0;
  let lastW = 0;
  let lastH = 0;

  const flush = (end: number) => {
    if (start < 0) return;
    const slice = text.slice(start, end);
    // Only white space is nothing to select.
    if (slice.trim() !== '') {
      runs.push({
        start,
        end,
        text: slice,
        x: x0,
        y: y0,
        w: Math.max(MIN_RUN_SIDE_PT, x1 - x0),
        h: Math.max(MIN_RUN_SIDE_PT, y1 - y0),
      });
    }
    start = -1;
  };

  for (let i = 0; i < text.length; i += 1) {
    if (isBreak(text.charCodeAt(i))) {
      flush(i);
      continue;
    }
    const x = boxes[4 * i] ?? 0;
    const y = boxes[4 * i + 1] ?? 0;
    const w = boxes[4 * i + 2] ?? 0;
    const h = boxes[4 * i + 3] ?? 0;
    if (start >= 0) {
      // The second code unit of a surrogate pair has the box of the first.
      const same = x === lastX && y === lastY && w === lastW && h === lastH;
      if (!same) {
        const height = Math.max(h, y1 - y0, MIN_RUN_SIDE_PT);
        const middle = (y0 + y1) / 2;
        const sameLine = Math.abs(y + h / 2 - middle) <= height * LINE_SHARE;
        const forward = x >= x1 - height * BACKSTEP_IN_HEIGHTS && x - x1 <= height * GAP_IN_HEIGHTS;
        if (!sameLine || !forward || i - start >= MAX_RUN_UNITS) flush(i);
      }
    }
    if (start < 0) {
      start = i;
      x0 = x;
      y0 = y;
      x1 = x + w;
      y1 = y + h;
    } else {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }
    lastX = x;
    lastY = y;
    lastW = w;
    lastH = h;
  }
  flush(text.length);
  return runs;
}

const cache = new WeakMap<object, readonly Run[]>();

/** `buildRuns`, remembered per layer (a layer is never edited). */
export function runsOf(layer: TextLayer): readonly Run[] {
  let runs = cache.get(layer);
  if (runs === undefined) {
    runs = buildRuns(layer);
    cache.set(layer, runs);
  }
  return runs;
}
