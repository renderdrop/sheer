import type { Rgb, TextAlign } from '../../../api/annotations';
import type { KindDefault } from '../../../stores/tools';
import { activePalettes, INK_RGB } from '../../inspector/palette';

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
export const firstBorderColour = (): Rgb => INK_RGB;
/** The fill a text box gets when it is switched on: the Solar position of the active set. */
export const firstFillColour = (): Rgb => activePalettes().highlight[3]?.rgb ?? INK_RGB;

export function textStyleOf(stored: KindDefault | undefined): TextStyle {
  return {
    align: stored?.align ?? 'left',
    borderWidth: stored?.border === true ? (stored.borderWidth ?? FIRST_BORDER_PT) : 0,
    borderColor: stored?.borderColor ?? firstBorderColour(),
    fill: stored?.fillOn === true ? (stored.fillColor ?? firstFillColour()) : null,
  };
}
