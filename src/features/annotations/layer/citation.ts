import type { Rgb } from '../../../api/annotations';
import { activePalettes, INK_RGB, sameRgb, SOLAR_INDEX } from '../../inspector/palette';

/** The citation's rule (DESIGN 3.7 C1): a solid line this thick, in points, at the baseline of each line of the quote. */
export const CITE_RULE_PT = 1;

/**
 * The colour of a citation's rule: the fill itself at full opacity when it is one of the set's colours (the fill is drawn at 45 %).
 * The Solar position is a pale fill that would hardly show as a rule, and a custom fill is none of the five, so both get Ink.
 */
export function strokePartner(fill: Rgb): Rgb {
  const index = activePalettes().highlight.findIndex((entry) => sameRgb(entry.rgb, fill));
  if (index < 0 || index === SOLAR_INDEX) return INK_RGB;
  return fill;
}
