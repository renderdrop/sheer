import { MAX_ANNOT_QUADS } from '../../../api/annotations';
import type { TextLayer } from '../../../api/text';
import type { Point, Quad, Rect } from '../../../api/wire';

/**
 * Text markup (highlight, underline, strikethrough; DESIGN 3.22): from characters of the text layer to the quads the annotation
 * covers, one per line. The layer has four numbers (x, y, w, h) per UTF-16 unit, in page space. Pure functions.
 */

export type TextBoxes = Pick<TextLayer, 'text' | 'boxes'>;

/** A character has an area, and is not a line break. */
function hasArea(layer: TextBoxes, index: number): boolean {
  const code = layer.text.charCodeAt(index);
  if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return false;
  const w = layer.boxes[4 * index + 2];
  const h = layer.boxes[4 * index + 3];
  return w !== undefined && h !== undefined && w > 0 && h > 0;
}

function boxAt(layer: TextBoxes, index: number): Rect {
  return {
    x: layer.boxes[4 * index] ?? 0,
    y: layer.boxes[4 * index + 1] ?? 0,
    w: layer.boxes[4 * index + 2] ?? 0,
    h: layer.boxes[4 * index + 3] ?? 0,
  };
}

function distanceToBox(p: Point, box: Rect): number {
  const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
  const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/**
 * The index of the character under `point`. With `strict` only a character that contains the point counts (`null` otherwise); else
 * the nearest one (`null` only for a page without characters).
 */
export function charIndexAt(layer: TextBoxes, point: Point, strict: boolean): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const count = Math.min(layer.text.length, Math.floor(layer.boxes.length / 4));
  for (let i = 0; i < count; i += 1) {
    if (!hasArea(layer, i)) continue;
    const distance = distanceToBox(point, boxAt(layer, i));
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return strict && bestDistance > 0 ? null : best;
}

/** Characters whose box meets the rectangle, in text order. */
export function indicesInRect(layer: TextBoxes, rect: Rect): number[] {
  const out: number[] = [];
  const count = Math.min(layer.text.length, Math.floor(layer.boxes.length / 4));
  for (let i = 0; i < count; i += 1) {
    if (!hasArea(layer, i)) continue;
    const b = boxAt(layer, i);
    if (b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y) out.push(i);
  }
  return out;
}

/** A line is cut where the next character is farther than this many heights away (a column gap). */
const GAP_IN_HEIGHTS = 3;
/** A character whose middle is farther than this share of the line's height from the line's middle starts a new line. */
const LINE_SHARE = 0.5;

/** One quad per line for these characters (indices in any order), capped at the model's limit. */
export function quadsForIndices(layer: TextBoxes, indices: readonly number[]): Quad[] {
  const sorted = [...indices].sort((a, b) => a - b);
  const quads: Quad[] = [];
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  let open = false;
  const flush = () => {
    if (open) {
      quads.push([
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x0, y: y1 },
        { x: x1, y: y1 },
      ]);
    }
    open = false;
  };
  for (const index of sorted) {
    if (!hasArea(layer, index)) continue;
    const b = boxAt(layer, index);
    if (open) {
      const mid = (y0 + y1) / 2;
      const height = y1 - y0;
      const sameLine = Math.abs(b.y + b.h / 2 - mid) <= LINE_SHARE * height;
      const near = b.x <= x1 + GAP_IN_HEIGHTS * height && b.x + b.w >= x0 - GAP_IN_HEIGHTS * height;
      if (sameLine && near) {
        x0 = Math.min(x0, b.x);
        x1 = Math.max(x1, b.x + b.w);
        y0 = Math.min(y0, b.y);
        y1 = Math.max(y1, b.y + b.h);
        continue;
      }
      flush();
    }
    x0 = b.x;
    x1 = b.x + b.w;
    y0 = b.y;
    y1 = b.y + b.h;
    open = true;
  }
  flush();
  return quads.slice(0, MAX_ANNOT_QUADS);
}

/** The quads of the text between two character indices (either order, both included). */
export function quadsForRange(layer: TextBoxes, a: number, b: number): Quad[] {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(layer.text.length - 1, Math.max(a, b));
  const indices: number[] = [];
  for (let i = lo; i <= hi; i += 1) indices.push(i);
  return quadsForIndices(layer, indices);
}

/** The quads of a drag: from the character under `start` (text flow) or, when there is none, of what the rectangle meets. */
export function quadsForDrag(layer: TextBoxes, start: Point, end: Point): Quad[] {
  const from = charIndexAt(layer, start, true);
  if (from !== null) {
    const to = charIndexAt(layer, end, false);
    return to === null ? [] : quadsForRange(layer, from, to);
  }
  const rect = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
  return quadsForIndices(layer, indicesInRect(layer, rect));
}

/** The quads of the text between two places of one page's text (a DOM selection resolved to UTF-16 offsets; end exclusive). */
export function quadsForOffsets(layer: TextBoxes, start: number, end: number): Quad[] {
  return end > start ? quadsForRange(layer, start, end - 1) : [];
}

/** A line of the page's text: the characters `first` to `last` (UTF-16 indices) and the box they cover. */
interface IndexedLine {
  first: number;
  last: number;
  box: Rect;
}

/**
 * The lines of a page's text, built once per drag, so that a pointer move looks at the lines (and the characters of one or two of
 * them) rather than at every character of the page.
 */
export interface TextIndex {
  layer: TextBoxes;
  lines: readonly IndexedLine[];
}

export function buildTextIndex(layer: TextBoxes): TextIndex {
  const lines: IndexedLine[] = [];
  const count = Math.min(layer.text.length, Math.floor(layer.boxes.length / 4));
  let open: { first: number; last: number; x0: number; x1: number; y0: number; y1: number } | null = null;
  const flush = () => {
    if (open !== null) {
      lines.push({
        first: open.first,
        last: open.last,
        box: { x: open.x0, y: open.y0, w: open.x1 - open.x0, h: open.y1 - open.y0 },
      });
    }
    open = null;
  };
  for (let i = 0; i < count; i += 1) {
    if (!hasArea(layer, i)) continue;
    const b = boxAt(layer, i);
    if (open !== null) {
      const height = open.y1 - open.y0;
      const sameLine = Math.abs(b.y + b.h / 2 - (open.y0 + open.y1) / 2) <= LINE_SHARE * height;
      const near = b.x <= open.x1 + GAP_IN_HEIGHTS * height && b.x + b.w >= open.x0 - GAP_IN_HEIGHTS * height;
      if (sameLine && near) {
        open.last = i;
        open.x0 = Math.min(open.x0, b.x);
        open.x1 = Math.max(open.x1, b.x + b.w);
        open.y0 = Math.min(open.y0, b.y);
        open.y1 = Math.max(open.y1, b.y + b.h);
        continue;
      }
      flush();
    }
    open = { first: i, last: i, x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h };
  }
  flush();
  return { layer, lines };
}

/** `charIndexAt` over the index: the nearest line first, then its characters. */
export function charIndexAtIndexed(index: TextIndex, point: Point, strict: boolean): number | null {
  let line: IndexedLine | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of index.lines) {
    const distance = distanceToBox(point, candidate.box);
    if (distance < best) {
      line = candidate;
      best = distance;
      if (distance === 0) break;
    }
  }
  if (line === null || (strict && best > 0)) return null;
  let found: number | null = null;
  let foundDistance = Number.POSITIVE_INFINITY;
  for (let i = line.first; i <= line.last; i += 1) {
    if (!hasArea(index.layer, i)) continue;
    const distance = distanceToBox(point, boxAt(index.layer, i));
    if (distance < foundDistance) {
      found = i;
      foundDistance = distance;
      if (distance === 0) break;
    }
  }
  return strict && foundDistance > 0 ? null : found;
}

/** The quad of the characters of a line between `a` and `b`, or null when none has an area (`keep` filters characters). */
function lineQuad(
  index: TextIndex,
  line: IndexedLine,
  a: number,
  b: number,
  keep?: (box: Rect) => boolean,
): Quad | null {
  let box: Rect | null = null;
  if (keep === undefined && a <= line.first && b >= line.last) {
    box = line.box;
  } else {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = Math.max(a, line.first); i <= Math.min(b, line.last); i += 1) {
      if (!hasArea(index.layer, i)) continue;
      const c = boxAt(index.layer, i);
      if (keep !== undefined && !keep(c)) continue;
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w);
      y1 = Math.max(y1, c.y + c.h);
    }
    if (x0 <= x1) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (box === null) return null;
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ];
}

/** `quadsForDrag` over the index; the same quads, found without a pass over every character. */
export function quadsForDragIndexed(index: TextIndex, start: Point, end: Point): Quad[] {
  const quads: Quad[] = [];
  const from = charIndexAtIndexed(index, start, true);
  if (from !== null) {
    const to = charIndexAtIndexed(index, end, false);
    if (to === null) return [];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (const line of index.lines) {
      if (line.last < lo || line.first > hi) continue;
      const quad = lineQuad(index, line, lo, hi);
      if (quad !== null) quads.push(quad);
      if (quads.length >= MAX_ANNOT_QUADS) break;
    }
    return quads;
  }
  const rect = boxFromCorners(start, end);
  const meets = (b: Rect) => b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y;
  for (const line of index.lines) {
    if (!meets(line.box)) continue;
    const quad = lineQuad(index, line, line.first, line.last, meets);
    if (quad !== null) quads.push(quad);
    if (quads.length >= MAX_ANNOT_QUADS) break;
  }
  return quads;
}

function boxFromCorners(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
