import type { Rgb, TextAlign } from '../../../api/annotations';
import type { KindDefault } from '../../../stores/tools';
import { HIGHLIGHT_PALETTE, STROKE_PALETTE } from '../../inspector/palette';

/**
 * What a new text comment looks like (DESIGN 3.5 B4): the last used values of the `tools` store, else the first-run defaults (Ink
 * 12 pt, left, border off, fill off). The border, when switched on, is 1 pt in the text's Ink; the fill is Solar (opaque).
 */
export interface TextStyle {
  align: TextAlign;
  /** 0 is no border. */
  borderWidth: number;
  borderColor: Rgb;
  fill: Rgb | null;
}

/** The width a border has when it is switched on for the first time. */
export const FIRST_BORDER_PT = 1;
export const BORDER_WIDTHS = [0.5, 1, 2] as const;
export const FIRST_BORDER_COLOUR: Rgb = STROKE_PALETTE[0]?.rgb ?? [15, 15, 15];
export const FIRST_FILL_COLOUR: Rgb = HIGHLIGHT_PALETTE[0]?.rgb ?? [255, 248, 77];

export function textStyleOf(stored: KindDefault | undefined): TextStyle {
  return {
    align: stored?.align ?? 'left',
    borderWidth: stored?.border === true ? (stored.borderWidth ?? FIRST_BORDER_PT) : 0,
    borderColor: stored?.borderColor ?? FIRST_BORDER_COLOUR,
    fill: stored?.fillOn === true ? (stored.fillColor ?? FIRST_FILL_COLOUR) : null,
  };
}
