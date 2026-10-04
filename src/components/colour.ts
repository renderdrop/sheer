/**
 * Colour helpers of the colour popover (DESIGN 3.5 B5): hex input parsing and the contrast of a stroke on a white page. Colours are
 * three bytes, as the document model stores them.
 */
export type Rgb3 = readonly [number, number, number];

/** How many colours "Recently used" keeps and shows. */
export const RECENT_COLOURS_MAX = 8;
/** How many recent custom colours sit in a swatch row beside the palette. */
export const RECENT_IN_ROW = 3;

/**
 * The colour a hex field holds: 3 or 6 hex digits, with or without a leading "#", any case, surrounding spaces ignored (a paste).
 * `null` for anything else.
 */
export function parseHex(input: string): Rgb3 | null {
  const digits = input.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(digits)) return null;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const byte = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
  return [byte(0), byte(2), byte(4)];
}

/** Six uppercase hex digits, without "#". */
export function toHex(rgb: Rgb3): string {
  return rgb
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function sameColour(a: Rgb3, b: Rgb3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

const linear = (n: number): number => {
  const c = n / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG contrast ratio of a colour on white, 1 to 21. */
export function contrastOnWhite([r, g, b]: Rgb3): number {
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return 1.05 / (luminance + 0.05);
}

/** A stroke needs 3:1 on white (DESIGN 2). */
export const MIN_STROKE_CONTRAST = 3;

/**
 * `colour` first, then `list` without repeats and at most `max` long: how a recent list takes a new colour (newest first,
 * deduplicated).
 */
export function pushRecent(list: readonly Rgb3[], colour: Rgb3, max = RECENT_COLOURS_MAX): Rgb3[] {
  return [colour, ...list.filter((known) => !sameColour(known, colour))].slice(0, max);
}
