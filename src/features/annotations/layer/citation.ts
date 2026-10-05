import type { Rgb } from '../../../api/annotations';
import { HIGHLIGHT_PALETTE, STROKE_PALETTE, sameRgb } from '../../inspector/palette';

/** The citation's rule (DESIGN 3.7 C1): a solid line this thick, in points, at the baseline of each line of the quote. */
export const CITE_RULE_PT = 1;

/**
 * The colour of a citation's rule: the stroke partner of its fill (Lavender fill, `--stroke-lavender` rule; Mint, Sky and Rose
 * likewise). Solar has no stroke partner (it is a fill only) and a custom fill is none of the five, so both get Ink.
 */
export function strokePartner(fill: Rgb): Rgb {
  const index = HIGHLIGHT_PALETTE.findIndex((entry) => sameRgb(entry.rgb, fill));
  const ink = STROKE_PALETTE[0]?.rgb ?? [15, 15, 15];
  if (index <= 0) return ink;
  // The stroke palette is Ink, Mint, Sky, Rose, Lavender; the highlight palette Solar, Mint, Sky, Rose, Lavender.
  return STROKE_PALETTE[index]?.rgb ?? ink;
}
