import type { TextLayer } from '../../api/text';
import type { Quad } from '../../api/wire';
import { quadBox, type Box } from '../viewer/transform';

/**
 * The text around a hit, for its row in the list (DESIGN 3.16). Rust reports a hit as the quads of the text it covers, not as a
 * character range, so the range is found here: the characters of the page's text layer whose box has its centre inside one of the
 * quads. The row shows the match in bold with up to `CONTEXT_CHARS` characters on each side. The text is the document's, so it is
 * only ever rendered as text nodes.
 */

export const CONTEXT_CHARS = 40;
/** The longest match shown; a hit of a whole paragraph is cut. */
export const MAX_MATCH_CHARS = 120;
/** Characters without a box in the quads that end the match (a line break sits between the lines of a hit that wraps). */
const MAX_MISSES = 3;

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/** The `[start, end)` UTF-16 range of the layer's text that the quads cover; `null` if no character is inside them. */
export function hitRange(layer: Pick<TextLayer, 'text' | 'boxes'>, quads: readonly Quad[]): [number, number] | null {
  const areas: Box[] = quads.map((quad) => quadBox(quad));
  const { text, boxes } = layer;
  let start = -1;
  let end = -1;
  let misses = 0;
  for (let i = 0; i < text.length; i += 1) {
    const w = boxes[4 * i + 2] ?? 0;
    const h = boxes[4 * i + 3] ?? 0;
    // A line break has no area and sits wherever the layout left it.
    if (w === 0 && h === 0) continue;
    const cx = (boxes[4 * i] ?? 0) + w / 2;
    const cy = (boxes[4 * i + 1] ?? 0) + h / 2;
    const inside = areas.some((area) => cx >= area.x && cx <= area.x + area.w && cy >= area.y && cy <= area.y + area.h);
    if (inside) {
      if (start < 0) start = i;
      end = i + 1;
      misses = 0;
    } else if (start >= 0) {
      misses += 1;
      if (misses > MAX_MISSES) break;
    }
  }
  return start < 0 ? null : [start, end];
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ');

/** The snippet of a hit; `null` when the hit cannot be placed in the text. */
export function snippetFor(
  layer: Pick<TextLayer, 'text' | 'boxes'>,
  quads: readonly Quad[],
  context: number = CONTEXT_CHARS,
): Snippet | null {
  const range = hitRange(layer, quads);
  if (range === null) return null;
  const [start, end] = range;
  const { text } = layer;
  // A split surrogate pair is not shown: the cut moves to the whole character.
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  const before = flatten(text.slice(from, start)).trimStart();
  const match = flatten(text.slice(start, Math.min(end, start + MAX_MATCH_CHARS)));
  const after = flatten(text.slice(Math.min(end, start + MAX_MATCH_CHARS), to)).trimEnd();
  return { before: dropLoneSurrogate(before, 'start'), match, after: dropLoneSurrogate(after, 'end') };
}

function dropLoneSurrogate(text: string, side: 'start' | 'end'): string {
  if (text === '') return text;
  if (side === 'start' && /^[\uDC00-\uDFFF]/.test(text)) return text.slice(1);
  if (side === 'end' && /[\uD800-\uDBFF]$/.test(text)) return text.slice(0, -1);
  return text;
}
