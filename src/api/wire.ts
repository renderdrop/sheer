/**
 * What the read commands (outline, text layer, search, links) have in common on the wire: a few number checks and the shapes of
 * page space (ADR-003 section 1; src-tauri/src/model/geometry.rs). Every answer of the backend goes through a parser before the
 * rest of the UI sees it, and an answer that does not have the documented shape is an internal error, like a malformed frame.
 */

/** Page space: points, origin at the top left of the page's box, y pointing down, before `/Rotate` is applied. */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in page space: its top left corner and its size (never negative). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Four corners of a rectangle: top left, top right, bottom left, bottom right. */
export type Quad = readonly [Point, Point, Point, Point];

/** The largest coordinate the backend sends, in points (ADR-003: coordinates are within +-14 400). */
export const MAX_COORDINATE_PT = 14_400;

/** A whole number from 0 to `max` (the ids, indices and counts of the backend are `u32`). */
export function isUint(value: unknown, max = 0xffff_ffff): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/** A finite number within page space. */
export function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE_PT;
}

/** A finite size in page space: not negative. */
export function isExtent(value: unknown): value is number {
  return isCoordinate(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a point; `null` if it is not one. Extra keys are dropped. */
export function parsePoint(value: unknown): Point | null {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  return isCoordinate(x) && isCoordinate(y) ? { x, y } : null;
}

/** Validates a rectangle; `null` if it is not one. Extra keys are dropped. */
export function parseRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  return isCoordinate(x) && isCoordinate(y) && isExtent(w) && isExtent(h) ? { x, y, w, h } : null;
}

/** Validates a quad (four points); `null` if it is not one. */
export function parseQuad(value: unknown): Quad | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const corners = (value as unknown[]).map(parsePoint);
  const [topLeft, topRight, bottomLeft, bottomRight] = corners;
  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return null;
  return [topLeft, topRight, bottomLeft, bottomRight];
}

/** Narrows `unknown` to a plain object for a parser that reads fields from it. */
export { isRecord };
