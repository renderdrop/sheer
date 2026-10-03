import type { TextLayer } from '../../api/text';
import { quadBox } from '../viewer/transform';
import type { RedactMark } from './store';

/** The longest excerpt kept, in characters; the row clamps it to two lines anyway. */
export const MAX_EXCERPT = 160;

/**
 * The text a text mark covers, read from the page's text layer: the characters whose box centre lies inside one of the mark's
 * quads, in content order, white space collapsed. Empty when the page has no text there.
 */
export function excerptOf(layer: Pick<TextLayer, 'text' | 'boxes'>, mark: Pick<RedactMark, 'quads'>): string {
  const areas = mark.quads.map((quad) => quadBox(quad));
  let out = '';
  for (let i = 0; i < layer.text.length && out.length < MAX_EXCERPT * 2; i += 1) {
    const cx = (layer.boxes[4 * i] ?? 0) + (layer.boxes[4 * i + 2] ?? 0) / 2;
    const cy = (layer.boxes[4 * i + 1] ?? 0) + (layer.boxes[4 * i + 3] ?? 0) / 2;
    if (areas.some((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h)) out += layer.text.charAt(i);
  }
  const text = out.replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}
