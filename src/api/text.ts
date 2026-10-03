import { call } from './call';
import { toAppError } from './errors';
import { MAX_COORDINATE_PT, isRecord } from './wire';

/**
 * The text layer of a page (ARCHITECTURE section 5, `get_text_layer`; src-tauri/src/commands/text.rs): the text and where each
 * character is, so that text can be selected and copied.
 */

/** Most UTF-16 code units in a layer (`MAX_TEXT_CHARS`). */
export const MAX_TEXT_CHARS = 200_000;

/**
 * The text of a page and the box of each character. `boxes` has four numbers (x, y, width, height, in page space: points, origin
 * at the top left of the page's box, y down, before `/Rotate`) for every UTF-16 code unit of `text`, so `text[i]` is in
 * `boxes.subarray(4 * i, 4 * i + 4)` as JavaScript counts: a character that is two code units (an emoji) has its box twice. A
 * line break the page's layout has (`\r\n`) has a box with no area. `truncated`: the page has more text than 200 000 code units
 * and this is the beginning. The text is the document's: render it as text only.
 */
export interface TextLayer {
  text: string;
  boxes: Float32Array;
  truncated: boolean;
  /** The page's own `/Rotate` in degrees (0, 90, 180 or 270): the boxes are before it. */
  rotation?: number;
}

const FILE_ROTATIONS: readonly unknown[] = [0, 90, 180, 270];

/**
 * Validates the answer of `get_text_layer`: a text of at most 200 000 code units, four finite numbers in page space for every one
 * of them (a size is not negative) and nothing else. `null` if it is not a text layer; extra keys are dropped.
 */
export function parseTextLayer(value: unknown): TextLayer | null {
  if (!isRecord(value)) return null;
  const { text, boxes, truncated, rotation = 0 } = value;
  if (!FILE_ROTATIONS.includes(rotation)) return null;
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS || typeof truncated !== 'boolean') return null;
  if (!Array.isArray(boxes) || boxes.length !== 4 * text.length) return null;
  const numbers = new Float32Array(boxes.length);
  for (let i = 0; i < boxes.length; i += 1) {
    const number = (boxes as unknown[])[i];
    // Position (x, y) is within the page space, a size (width, height) is not negative.
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE_PT) return null;
    if (i % 4 >= 2 && number < 0) return null;
    numbers[i] = number;
  }
  return { text, boxes: numbers, truncated, rotation: rotation as number };
}

/**
 * The text layer of a page of an open document. An answer that does not have the documented shape is an internal error. Rejects
 * with `invalid_argument` for a page the document does not have and `not_found` for a document that is not open.
 */
export async function getTextLayer(docId: number, pageId: number): Promise<TextLayer> {
  const layer = parseTextLayer(await call<unknown>('get_text_layer', { docId, pageId }));
  if (layer === null) throw toAppError(null);
  return layer;
}
