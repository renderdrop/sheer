import type { Annotation, Rgb } from '../../api/annotations';

/**
 * The annotation palettes (DESIGN v2 1.4, 2.7): document content, the same in both themes because annotation colours sit on a white
 * page. Highlights use the five `--hl-*` tints, strokes (pen, shapes, text colour) Ink and the four `--stroke-*` colours, and Solar
 * only ever as a fill. `rgb` is what the model stores; `bg` and `check` are static class names (Tailwind must see them whole) of the
 * tokens, which hold the same values.
 */
export type PaletteName = 'highlight' | 'stroke' | 'fill' | 'signature';

export interface PaletteColour {
  id: 'solar' | 'mint' | 'sky' | 'rose' | 'lavender' | 'ink' | 'solarFill' | 'signatureInk';
  rgb: Rgb;
  bg: string;
  /** The check mark: white on the dark swatches, ink on the light ones. */
  check: string;
  nameKey:
    | 'colour.solar'
    | 'colour.mint'
    | 'colour.sky'
    | 'colour.rose'
    | 'colour.lavender'
    | 'colour.ink'
    | 'colour.solarFill'
    | 'colour.signatureInk';
}

const WHITE = 'text-page';
const INK = 'text-ink';

export const HIGHLIGHT_PALETTE: readonly PaletteColour[] = [
  { id: 'solar', rgb: [255, 248, 77], bg: 'bg-hl-solar', check: INK, nameKey: 'colour.solar' },
  { id: 'mint', rgb: [125, 235, 181], bg: 'bg-hl-mint', check: INK, nameKey: 'colour.mint' },
  { id: 'sky', rgb: [163, 222, 255], bg: 'bg-hl-sky', check: INK, nameKey: 'colour.sky' },
  { id: 'rose', rgb: [255, 199, 215], bg: 'bg-hl-rose', check: INK, nameKey: 'colour.rose' },
  { id: 'lavender', rgb: [220, 207, 255], bg: 'bg-hl-lavender', check: INK, nameKey: 'colour.lavender' },
];

export const STROKE_PALETTE: readonly PaletteColour[] = [
  { id: 'ink', rgb: [15, 15, 15], bg: 'bg-stroke-ink', check: WHITE, nameKey: 'colour.ink' },
  { id: 'mint', rgb: [31, 158, 106], bg: 'bg-stroke-mint', check: WHITE, nameKey: 'colour.mint' },
  { id: 'sky', rgb: [61, 143, 209], bg: 'bg-stroke-sky', check: WHITE, nameKey: 'colour.sky' },
  { id: 'rose', rgb: [225, 92, 134], bg: 'bg-stroke-rose', check: WHITE, nameKey: 'colour.rose' },
  { id: 'lavender', rgb: [146, 120, 230], bg: 'bg-stroke-lavender', check: WHITE, nameKey: 'colour.lavender' },
];

/** Solar is a fill only: it is not a stroke colour, and the picker says so in its name. */
export const SOLAR_FILL: PaletteColour = {
  id: 'solarFill',
  rgb: [255, 248, 77],
  bg: 'bg-stroke-solar',
  check: INK,
  nameKey: 'colour.solarFill',
};

/** What a fill (a note) offers: Solar, then the strokes. */
export const FILL_PALETTE: readonly PaletteColour[] = [SOLAR_FILL, ...STROKE_PALETTE];

/** The ink of a signature: Ink or the one blue of the interface, `--ink-signature`. */
export const SIGNATURE_PALETTE: readonly PaletteColour[] = [
  { id: 'ink', rgb: [15, 15, 15], bg: 'bg-stroke-ink', check: WHITE, nameKey: 'colour.ink' },
  { id: 'signatureInk', rgb: [31, 58, 147], bg: 'bg-ink-signature', check: WHITE, nameKey: 'colour.signatureInk' },
];

export const PALETTES: Readonly<Record<PaletteName, readonly PaletteColour[]>> = {
  highlight: HIGHLIGHT_PALETTE,
  stroke: STROKE_PALETTE,
  fill: FILL_PALETTE,
  signature: SIGNATURE_PALETTE,
};

/** The kinds of annotation that have the highlight palette. */
export const paletteNameOf = (kind: string): PaletteName =>
  kind === 'highlight' || kind === 'citation'
    ? 'highlight'
    : kind === 'note'
      ? 'fill'
      : kind === 'signature'
        ? 'signature'
        : 'stroke';

const first = (palette: readonly PaletteColour[]): Rgb => palette[0]?.rgb ?? [15, 15, 15];

/** The defaults: Highlight Solar, everything drawn Ink, Note Solar (a fill). */
export const DEFAULT_COLOURS = {
  highlight: first(HIGHLIGHT_PALETTE),
  /** A citation starts Lavender (`--citation-default`, DESIGN 3.7 C1), so it differs from a plain highlight at first sight. */
  citation: HIGHLIGHT_PALETTE[4]?.rgb ?? first(HIGHLIGHT_PALETTE),
  underline: first(STROKE_PALETTE),
  strikeout: first(STROKE_PALETTE),
  note: first(FILL_PALETTE),
  freeText: first(STROKE_PALETTE),
  ink: first(STROKE_PALETTE),
  shape: first(STROKE_PALETTE),
} as const;

/** The alpha written into a highlight. It is the value of the `--hl-opacity` token (a test keeps the two equal): annotation data cannot read CSS. */
export const HIGHLIGHT_OPACITY = 0.45;

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** The entry of `rgb` in a palette. */
export function paletteEntry(
  rgb: Rgb,
  palette: PaletteName | readonly PaletteName[] = 'stroke',
): PaletteColour | undefined {
  const names = typeof palette === 'string' ? [palette] : palette;
  for (const name of names) {
    const found = PALETTES[name].find((colour) => sameRgb(colour.rgb, rgb));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A stored colour that is not in the palette of its kind (a colour of an old file): it gets the extra "Custom" swatch. */
export function isCustomColour(rgb: Rgb, palette: PaletteName): boolean {
  return paletteEntry(rgb, palette) === undefined;
}

/** A persisted last-used colour that is no longer in the palette of its kind (the Okabe-Ito of v1.1) becomes the default. */
export function migrateColour(value: unknown, palette: PaletteName, fallback: Rgb): Rgb {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return fallback;
  }
  // Checked above: exactly three integer bytes.
  const rgb = value as unknown as Rgb;
  return paletteEntry(rgb, palette) === undefined ? fallback : rgb;
}

/** The CSS colour of a colour that came from a file. The values are bytes (the parser guarantees 0 to 255). */
export function rgbToCss(rgb: Rgb): string {
  return `color(srgb ${rgb[0] / 255} ${rgb[1] / 255} ${rgb[2] / 255})`;
}

/** How many colours "Recent" shows. */
export const RECENT_MAX = 4;

/** The colours found in the file (newest first) that are in no palette, without repeats. */
export function recentColours(annotations: Iterable<Annotation>): Rgb[] {
  const sorted = [...annotations].sort((a, b) => b.id - a.id);
  const found: Rgb[] = [];
  for (const annotation of sorted) {
    if (annotation.kind === 'opaque') continue;
    const colour = annotation.color;
    if (
      paletteEntry(colour, ['highlight', 'stroke', 'fill', 'signature']) !== undefined ||
      found.some((known) => sameRgb(known, colour))
    ) {
      continue;
    }
    found.push(colour);
    if (found.length === RECENT_MAX) break;
  }
  return found;
}
