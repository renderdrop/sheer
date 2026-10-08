import { create } from 'zustand';

import type { Annotation, Rgb } from '../../api/annotations';

/**
 * The annotation palettes (DESIGN v2 1.4, 2.7; F19.19, ADR-143): document content, the same in both themes because annotation colours
 * sit on a white page. A palette SET is five colours; highlight, stroke and fill pickers all read the active set (strokes add the
 * neutral Ink before the five). Swatches are painted inline from `rgb`: no class per colour. The ONLY colour literals of the pickers
 * live in this file (`paletteSource.test.ts` scans for them).
 */
export type PaletteName = 'highlight' | 'stroke' | 'fill' | 'signature';

export interface PaletteColour {
  id: string;
  rgb: Rgb;
  /** A static token class that paints the swatch (only the signature inks); otherwise the swatch is painted from `rgb`. */
  bg?: string;
  /** The check mark: white on the dark swatches, ink on the light ones. */
  check: string;
  nameKey:
    | 'colour.slot1'
    | 'colour.slot2'
    | 'colour.slot3'
    | 'colour.slot4'
    | 'colour.slot5'
    | 'colour.ink'
    | 'colour.signatureInk';
}

const WHITE = 'text-page';
const INK = 'text-ink';

export const INK_RGB: Rgb = [15, 15, 15];

/**
 * The five colours of each set as RGB (the source of truth; the first set is the default). Owner hex (F19.19):
 * iris   EF35F2 00F5FF 6EF230 FFF84D FF4103
 * earth  093699 B7CF4F 2A5239 DAD1CA C54712
 * berry  A61B4E D92567 F2509C D4D93D D6CECE
 * study  174FBF A7D5F2 1B4427 B0BF3F F2EDD5
 */
export const PALETTE_RGB = {
  iris: [
    [239, 53, 242],
    [0, 245, 255],
    [110, 242, 48],
    [255, 248, 77],
    [255, 65, 3],
  ],
  earth: [
    [9, 54, 153],
    [183, 207, 79],
    [42, 82, 57],
    [218, 209, 202],
    [197, 71, 18],
  ],
  berry: [
    [166, 27, 78],
    [217, 37, 103],
    [242, 80, 156],
    [212, 217, 61],
    [214, 206, 206],
  ],
  study: [
    [23, 79, 191],
    [167, 213, 242],
    [27, 68, 39],
    [176, 191, 63],
    [242, 237, 213],
  ],
} as const satisfies Readonly<Record<string, readonly Rgb[]>>;

export type PaletteSetName = keyof typeof PALETTE_RGB;
export const PALETTE_SET_NAMES = Object.keys(PALETTE_RGB) as readonly PaletteSetName[];
export const DEFAULT_PALETTE_SET: PaletteSetName = 'iris';

const SLOTS = ['colour.slot1', 'colour.slot2', 'colour.slot3', 'colour.slot4', 'colour.slot5'] as const;

const luma = ([r, g, b]: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const INK_COLOUR: PaletteColour = { id: 'ink', rgb: INK_RGB, bg: 'bg-stroke-ink', check: WHITE, nameKey: 'colour.ink' };

/** The ink of a signature: Ink or the one blue of the interface, `--ink-signature`. It does not follow the set (ADR-143). */
export const SIGNATURE_PALETTE: readonly PaletteColour[] = [
  INK_COLOUR,
  { id: 'signatureInk', rgb: [31, 58, 147], bg: 'bg-ink-signature', check: WHITE, nameKey: 'colour.signatureInk' },
];

export type PaletteSet = Readonly<Record<PaletteName, readonly PaletteColour[]>>;

function buildSet(colours: readonly (readonly [number, number, number])[]): PaletteSet {
  const five: PaletteColour[] = colours.map(([r, g, b], index) => {
    const rgb: Rgb = [r, g, b];
    return { id: `c${index + 1}`, rgb, check: luma(rgb) > 0.4 ? INK : WHITE, nameKey: SLOTS[index] ?? 'colour.slot1' };
  });
  return { highlight: five, stroke: [INK_COLOUR, ...five], fill: five, signature: SIGNATURE_PALETTE };
}

/** The named palette sets: the ONE place that owns every colour the pickers, the inspector and the defaults offer. */
export const PALETTE_SETS: Readonly<Record<PaletteSetName, PaletteSet>> = {
  iris: buildSet(PALETTE_RGB.iris),
  earth: buildSet(PALETTE_RGB.earth),
  berry: buildSet(PALETTE_RGB.berry),
  study: buildSet(PALETTE_RGB.study),
};

/** Tags and stamps keep fixed colours that do not follow the set (ADR-143): the Iris v1 tints, as token classes. */
export const TAG_SWATCHES = [
  { rgb: [255, 248, 77], bg: 'bg-hl-solar', nameKey: 'colour.solar' },
  { rgb: [125, 235, 181], bg: 'bg-hl-mint', nameKey: 'colour.mint' },
  { rgb: [163, 222, 255], bg: 'bg-hl-sky', nameKey: 'colour.sky' },
  { rgb: [255, 199, 215], bg: 'bg-hl-rose', nameKey: 'colour.rose' },
  { rgb: [220, 207, 255], bg: 'bg-hl-lavender', nameKey: 'colour.lavender' },
] as const satisfies readonly {
  rgb: Rgb;
  bg: string;
  nameKey: 'colour.solar' | 'colour.mint' | 'colour.sky' | 'colour.rose' | 'colour.lavender';
}[];

/** The fixed Solar of the stamp tones. */
export const STAMP_SOLAR: Rgb = [255, 248, 77];

export const PALETTE_SET_KEY = 'sheer.paletteSet';

function readSet(): PaletteSetName {
  try {
    const raw = globalThis.localStorage?.getItem(PALETTE_SET_KEY) ?? '';
    return PALETTE_SET_NAMES.find((name) => name === raw) ?? DEFAULT_PALETTE_SET;
  } catch {
    return DEFAULT_PALETTE_SET;
  }
}

export interface PaletteStoreState {
  /** The active set, app-wide (not per document). Switching never recolours an annotation. */
  set: PaletteSetName;
  choose: (name: PaletteSetName) => void;
}

export const usePaletteSet = create<PaletteStoreState>()((set) => ({
  set: readSet(),
  choose: (name) => {
    try {
      globalThis.localStorage?.setItem(PALETTE_SET_KEY, name);
    } catch {
      // Storage may be unavailable; the choice then lasts for the session.
    }
    set({ set: name });
  },
}));

/** The palettes every surface reads: the active set (outside React). */
export const activePalettes = (): PaletteSet => PALETTE_SETS[usePaletteSet.getState().set];

/** The active palettes, and a re-render when the set changes. */
export function usePalettes(): PaletteSet {
  return PALETTE_SETS[usePaletteSet((state) => state.set)];
}

/** The kinds of annotation that have the highlight palette. */
export const paletteNameOf = (kind: string): PaletteName =>
  kind === 'highlight' || kind === 'citation'
    ? 'highlight'
    : kind === 'note'
      ? 'fill'
      : kind === 'signature'
        ? 'signature'
        : 'stroke';

/** The position of Solar in every set: the default of highlights and notes. */
export const SOLAR_INDEX = 3;
/** The default of a citation: colour 5 (the Lavender of Iris v1 is in no set). */
export const CITATION_INDEX = 4;

const pick = (palette: readonly PaletteColour[], index: number): Rgb => palette[index]?.rgb ?? INK_RGB;

/** The defaults, from the active set: Highlight and Note at the Solar position, everything drawn Ink. */
export function defaultColours() {
  const { highlight, fill } = activePalettes();
  return {
    highlight: pick(highlight, SOLAR_INDEX),
    citation: pick(highlight, CITATION_INDEX),
    underline: INK_RGB,
    strikeout: INK_RGB,
    note: pick(fill, SOLAR_INDEX),
    freeText: INK_RGB,
    ink: INK_RGB,
    shape: INK_RGB,
  } as const;
}

/** The alpha written into a highlight. It is the value of the `--hl-opacity` token (a test keeps the two equal): annotation data cannot read CSS. */
export const HIGHLIGHT_OPACITY = 0.45;

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** The entry of `rgb` in a palette of the active set. */
export function paletteEntry(
  rgb: Rgb,
  palette: PaletteName | readonly PaletteName[] = 'stroke',
): PaletteColour | undefined {
  const names = typeof palette === 'string' ? [palette] : palette;
  const set = activePalettes();
  for (const name of names) {
    const found = set[name].find((colour) => sameRgb(colour.rgb, rgb));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A stored colour that is not in the palette of its kind (a colour of another set or an old file): it gets the extra "Custom" swatch. */
export function isCustomColour(rgb: Rgb, palette: PaletteName): boolean {
  return paletteEntry(rgb, palette) === undefined;
}

/** A persisted last-used colour that is no longer in the palette of its kind becomes the default. */
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
