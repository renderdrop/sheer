import { MAX_REDACT_QUADS_PER_MARK } from '../../api/redaction';
import type { TextLayer } from '../../api/text';
import type { Quad } from '../../api/wire';
import { runsOf } from '../textlayer/runs';
import type { Box } from '../viewer/transform';

/** The smallest side of a dragged area mark, in points (DESIGN 3.38). */
export const MIN_AREA_PT = 4;

/** A quad as Rust has it: top left, top right, bottom left, bottom right. */
export function boxToQuad(box: Box): Quad {
  const { x, y, w, h } = box;
  return [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ];
}

/** The box of two corners given in any order, clamped to the page `[0, width] x [0, height]`. */
export function cornersToBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  page: readonly [number, number],
): Box {
  const clampX = (x: number) => Math.min(page[0], Math.max(0, x));
  const clampY = (y: number) => Math.min(page[1], Math.max(0, y));
  const x0 = clampX(Math.min(a.x, b.x));
  const x1 = clampX(Math.max(a.x, b.x));
  const y0 = clampY(Math.min(a.y, b.y));
  const y1 = clampY(Math.max(a.y, b.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The handles of an area mark: the page-space edges each one moves (-1 low edge, 1 high edge, 0 none). */
export const HANDLES: readonly { name: string; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }[] = [
  { name: 'nw', dx: -1, dy: -1 },
  { name: 'n', dx: 0, dy: -1 },
  { name: 'ne', dx: 1, dy: -1 },
  { name: 'e', dx: 1, dy: 0 },
  { name: 'se', dx: 1, dy: 1 },
  { name: 's', dx: 0, dy: 1 },
  { name: 'sw', dx: -1, dy: 1 },
  { name: 'w', dx: -1, dy: 0 },
];

/** `box` with the edges of a handle moved by the delta; the sides never go below `MIN_AREA_PT` and the result stays on the page. */
export function resizeBox(
  box: Box,
  handle: { dx: -1 | 0 | 1; dy: -1 | 0 | 1 },
  delta: { x: number; y: number },
  page: readonly [number, number],
): Box {
  let x0 = box.x;
  let y0 = box.y;
  let x1 = box.x + box.w;
  let y1 = box.y + box.h;
  if (handle.dx < 0) x0 = Math.min(x1 - MIN_AREA_PT, Math.max(0, x0 + delta.x));
  if (handle.dx > 0) x1 = Math.max(x0 + MIN_AREA_PT, Math.min(page[0], x1 + delta.x));
  if (handle.dy < 0) y0 = Math.min(y1 - MIN_AREA_PT, Math.max(0, y0 + delta.y));
  if (handle.dy > 0) y1 = Math.max(y0 + MIN_AREA_PT, Math.min(page[1], y1 + delta.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The box moved by the delta, kept on the page. */
export function moveBox(box: Box, delta: { x: number; y: number }, page: readonly [number, number]): Box {
  return {
    ...box,
    x: Math.min(page[0] - box.w, Math.max(0, box.x + delta.x)),
    y: Math.min(page[1] - box.h, Math.max(0, box.y + delta.y)),
  };
}

/**
 * The quads of the text between two offsets of a page's text: one per line fragment (a run's part), made of the boxes of its
 * characters. White space and line breaks at the ends of a fragment are left out; a fragment with no area is skipped.
 */
export function quadsForRange(layer: Pick<TextLayer, 'text' | 'boxes'>, start: number, end: number): Quad[] {
  const quads: Quad[] = [];
  for (const run of runsOf(layer as TextLayer)) {
    const from = Math.max(start, run.start);
    const to = Math.min(end, run.end);
    if (to <= from) continue;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = from; i < to; i += 1) {
      const w = layer.boxes[4 * i + 2] ?? 0;
      const h = layer.boxes[4 * i + 3] ?? 0;
      if (layer.text.charAt(i).trim() === '' || (w === 0 && h === 0)) continue;
      const x = layer.boxes[4 * i] ?? 0;
      const y = layer.boxes[4 * i + 1] ?? 0;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }
    if (Number.isFinite(x0) && x1 > x0 && y1 > y0) quads.push(boxToQuad({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }));
  }
  return quads;
}

/** Splits a long quad list into the lists one mark may hold. */
export function chunkQuads(quads: readonly Quad[]): Quad[][] {
  const chunks: Quad[][] = [];
  for (let i = 0; i < quads.length; i += MAX_REDACT_QUADS_PER_MARK)
    chunks.push(quads.slice(i, i + MAX_REDACT_QUADS_PER_MARK));
  return chunks;
}

/** "1, 3-5" for ascending 1-based page numbers (consecutive numbers are joined). */
export function formatPages(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    const first = sorted[i] as number;
    const last = sorted[j] as number;
    parts.push(first === last ? `${first}` : j === i + 1 ? `${first}, ${last}` : `${first}-${last}`);
    i = j + 1;
  }
  return parts.join(', ');
}
