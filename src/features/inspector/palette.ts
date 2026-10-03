import type { Annotation, Rgb } from '../../api/annotations';

/**
 * The annotation palette (DESIGN 3.24, ADR-029): the eight Okabe-Ito colours, the same in both themes because annotation colours are
 * document content on a white page. `rgb` is what the model stores; `bg` and `check` are static class names (Tailwind must see them
 * whole) of the `--annot-*` tokens, which hold the same values.
 */
export interface PaletteColour {
  id: 'yellow' | 'orange' | 'vermillion' | 'purple' | 'blue' | 'sky' | 'green' | 'black';
  rgb: Rgb;
  bg: string;
  /** The check mark: white on the dark swatches, ink on the light ones. */
  check: string;
  nameKey:
    | 'colour.yellow'
    | 'colour.orange'
    | 'colour.vermillion'
    | 'colour.purple'
    | 'colour.blue'
    | 'colour.sky'
    | 'colour.green'
    | 'colour.black';
}

const WHITE = 'text-page';
const INK = 'text-annot-black';

export const PALETTE: readonly PaletteColour[] = [
  { id: 'yellow', rgb: [240, 228, 66], bg: 'bg-annot-yellow', check: INK, nameKey: 'colour.yellow' },
  { id: 'orange', rgb: [230, 159, 0], bg: 'bg-annot-orange', check: INK, nameKey: 'colour.orange' },
  { id: 'vermillion', rgb: [213, 94, 0], bg: 'bg-annot-vermillion', check: INK, nameKey: 'colour.vermillion' },
  { id: 'purple', rgb: [204, 121, 167], bg: 'bg-annot-purple', check: INK, nameKey: 'colour.purple' },
  { id: 'blue', rgb: [0, 114, 178], bg: 'bg-annot-blue', check: WHITE, nameKey: 'colour.blue' },
  { id: 'sky', rgb: [86, 180, 233], bg: 'bg-annot-sky', check: INK, nameKey: 'colour.sky' },
  { id: 'green', rgb: [0, 158, 115], bg: 'bg-annot-green', check: INK, nameKey: 'colour.green' },
  { id: 'black', rgb: [0, 0, 0], bg: 'bg-annot-black', check: WHITE, nameKey: 'colour.black' },
];

const byId = (id: PaletteColour['id']): Rgb => PALETTE.find((colour) => colour.id === id)?.rgb ?? [0, 0, 0];

/** The defaults of DESIGN 3.24: Highlight yellow, Underline and Strikethrough vermillion, Note yellow, Text black, Draw and Shapes blue. */
export const DEFAULT_COLOURS = {
  highlight: byId('yellow'),
  underline: byId('vermillion'),
  strikeout: byId('vermillion'),
  note: byId('yellow'),
  freeText: byId('black'),
  ink: byId('blue'),
  shape: byId('blue'),
} as const;

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function paletteEntry(rgb: Rgb): PaletteColour | undefined {
  return PALETTE.find((colour) => sameRgb(colour.rgb, rgb));
}

/** The CSS colour of a colour that came from a file. The values are bytes (the parser guarantees 0 to 255). */
export function rgbToCss(rgb: Rgb): string {
  return `color(srgb ${rgb[0] / 255} ${rgb[1] / 255} ${rgb[2] / 255})`;
}

/** How many colours "Recent" shows. */
export const RECENT_MAX = 4;

/**
 * "Recent" (ADR-029): the last colours found in the file (by id, newest first) that are not in the palette, without repeats. A file may
 * hold any colour; the palette holds eight. Annotations of the fill are not colours of the annotation and do not count.
 */
export function recentColours(annotations: Iterable<Annotation>): Rgb[] {
  const sorted = [...annotations].sort((a, b) => b.id - a.id);
  const found: Rgb[] = [];
  for (const annotation of sorted) {
    if (annotation.kind === 'opaque') continue;
    const colour = annotation.color;
    if (paletteEntry(colour) !== undefined || found.some((known) => sameRgb(known, colour))) continue;
    found.push(colour);
    if (found.length === RECENT_MAX) break;
  }
  return found;
}
