import type { StampKind, StampTone } from '../../../api/annotations';
import type { Point, Rect } from '../../../api/wire';
import type { Locale } from '../../../i18n';
import { textWidth } from '../create/freeTextLayout';

/**
 * The pure rules of stamps (DESIGN 3.14, ARCHITECTURE 16.1): the predefined stamps, the text and date a choice makes, the size of a new
 * stamp, where a click or a drag puts it, the recent own texts. Numbers are page points; the sizes mirror the `--stamp-*` tokens
 * (a test compares) and the backend's `model/stamp.rs` (the same fit, so the preview is what the file shows).
 */

/** The predefined stamps in the picker's order. */
export const PRESETS = ['draft', 'approved', 'confidential', 'received'] as const;
export type Preset = (typeof PRESETS)[number];

export const STAMP_HEIGHT_PT = 40;
export const STAMP_HEIGHT_DATED_PT = 56;
export const STAMP_MIN_WIDTH_PT = 96;
export const STAMP_PAD_X_PT = 12;
export const STAMP_BORDER_PT = 1.5;
export const STAMP_RADIUS_PT = 4;
/** A dragged stamp is at least this high. */
export const STAMP_MIN_DRAG_HEIGHT_PT = 20;
/** The text of one line at the default size; with a date line the label is 16 pt and the date 11 pt. */
export const STAMP_FONT_PT = 18;
export const STAMP_FONT_DATED_PT = 16;
export const STAMP_DATE_FONT_PT = 11;
/** The longest own text, in characters (the field's limit; the backend takes 64). */
export const OWN_TEXT_MAX = 32;
/** How many recent own texts the picker keeps. */
export const RECENT_MAX = 3;
/** The keyboard ghost moves this many screen px (Shift: 1). */
export const GHOST_STEP_PX = 8;
export const GHOST_STEP_FINE_PX = 1;

/** The widths of Helvetica-Bold for the characters U+0020 to U+007E, in 1/1000 em (the AFM the backend's `std14` holds). */
const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
] as const;

/** The width of one character in 1/1000 em: an accented letter has the width of its base letter (as in the AFM), ß is 611. */
function boldUnits(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return BOLD_WIDTHS[code - 0x20] ?? 556;
  if (code === 0xdf) return 611;
  const base = char.normalize('NFD').codePointAt(0) ?? 0;
  return base >= 0x41 && base <= 0x7a ? (BOLD_WIDTHS[base - 0x20] ?? 556) : 556;
}

/** The width of `text` in Helvetica-Bold at `size` points. A character the table does not hold counts as 556. */
export function boldWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) units += boldUnits(char);
  return (units * size) / 1000;
}

/** What the picker has chosen: a predefined stamp or the own text, the date switch for the own text, and the colour. */
export interface StampChoice {
  stamp: StampKind;
  /** The own text (for `custom`). */
  custom: string;
  /** Adds today's date to an own text. */
  withDate: boolean;
  tone: StampTone;
}

export const FIRST_CHOICE: StampChoice = { stamp: 'draft', custom: '', withDate: false, tone: 'solar' };

/** A stamp as it is placed: the visible label and the date line (`null` for none). */
export interface StampFace {
  stamp: StampKind;
  text: string;
  date: string | null;
}

/** The narrow no-break space and the thin space, which WinAnsi has no glyph for (written as code points: they are invisible in source). */
const NARROW_SPACES = new RegExp(`[${String.fromCharCode(0x202f, 0x2009)}]`, 'g');

/** The date as the UI writes it ("07.10.2026", "Oct 7, 2026"); only WinAnsi characters (a narrow no-break space becomes a space). */
export function formatStampDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date).replace(NARROW_SPACES, ' ');
}

/** The own text as it is stored: trimmed, on one line, at most `OWN_TEXT_MAX` characters. */
export function cleanOwn(text: string): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, OWN_TEXT_MAX).join('');
}

/**
 * The face a choice makes at placing time. `label` names a predefined stamp in the UI language; predefined labels are upper case in
 * that language ("ENTWURF"), an own text is as typed. `Received` always has the day's date. `null` for an empty own text.
 */
export function faceOf(
  choice: StampChoice,
  label: (preset: Preset) => string,
  locale: Locale,
  today: Date,
): StampFace | null {
  if (choice.stamp === 'custom') {
    const text = cleanOwn(choice.custom);
    return text === ''
      ? null
      : { stamp: 'custom', text, date: choice.withDate ? formatStampDate(today, locale) : null };
  }
  return {
    stamp: choice.stamp,
    text: label(choice.stamp).toLocaleUpperCase(locale),
    date: choice.stamp === 'received' ? formatStampDate(today, locale) : null,
  };
}

/** A recent own text: the text and whether it had the date. */
export interface RecentText {
  text: string;
  date: boolean;
}

/** `entry` first, an equal one (exact text and date flag) removed, at most `RECENT_MAX` kept. */
export function pushRecent(list: readonly RecentText[], entry: RecentText): RecentText[] {
  const rest = list.filter((item) => item.text !== entry.text || item.date !== entry.date);
  return [entry, ...rest].slice(0, RECENT_MAX);
}

/** The recent list from storage (outside input): whatever is wrong is dropped. */
export function parseRecent(raw: unknown): RecentText[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentText[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { text, date } = item as Record<string, unknown>;
    if (typeof text !== 'string' || typeof date !== 'boolean') continue;
    const clean = cleanOwn(text);
    if (clean !== '') out.push({ text: clean, date });
  }
  return out.slice(0, RECENT_MAX);
}

/** The size of a new stamp: the height of the token, the width of the text plus the padding, at least the minimum. */
export function defaultSize(face: Pick<StampFace, 'text' | 'date'>): { w: number; h: number } {
  const dated = face.date !== null;
  let text = boldWidth(face.text, dated ? STAMP_FONT_DATED_PT : STAMP_FONT_PT);
  if (face.date !== null) text = Math.max(text, textWidth(face.date, STAMP_DATE_FONT_PT));
  return {
    w: Math.max(STAMP_MIN_WIDTH_PT, text + 2 * STAMP_PAD_X_PT),
    h: dated ? STAMP_HEIGHT_DATED_PT : STAMP_HEIGHT_PT,
  };
}

/** The picker tile's dated stamp: a compact box (40 high) whose label is 12 pt and date 10 pt, so the date stays legible at tile size. */
export function tileGeometry(
  face: Pick<StampFace, 'text' | 'date'>,
): { w: number; h: number; layout: TextLayout } | null {
  if (face.date === null) return null;
  const w = Math.max(60, Math.max(boldWidth(face.text, 12), textWidth(face.date, 10)) + 2 * STAMP_PAD_X_PT);
  return { w, h: 40, layout: { size: 12, baseline: 17, dateSize: 10, dateBaseline: 31 } };
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** A box of `w` by `h` with its top left at (`x`, `y`) moved to lie inside the page (a box larger than the page is shrunk to it). */
function inPage(x: number, y: number, w: number, h: number, page: readonly [number, number]): Rect {
  const width = Math.min(w, page[0]);
  const height = Math.min(h, page[1]);
  return { x: clamp(x, 0, page[0] - width), y: clamp(y, 0, page[1] - height), w: width, h: height };
}

/** A click: the default size, centred on the click, inside the page. */
export function clickBox(at: Point, size: { w: number; h: number }, page: readonly [number, number]): Rect {
  return inPage(at.x - size.w / 2, at.y - size.h / 2, size.w, size.h, page);
}

/** A drag from `from` to `to`: the stamp fills the dragged box with its aspect kept (the smaller fit wins), at least 20 pt high. */
export function dragBox(from: Point, to: Point, size: { w: number; h: number }, page: readonly [number, number]): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const fit = Math.min(Math.abs(to.x - from.x) / size.w, Math.abs(to.y - from.y) / size.h);
  const scale = Math.max(fit, STAMP_MIN_DRAG_HEIGHT_PT / size.h);
  return inPage(x, y, size.w * scale, size.h * scale, page);
}

/** The keyboard ghost's first place: the centre of the visible part of the page (its centre when nothing is known). */
export function ghostStart(visible: Rect | null, page: readonly [number, number]): Point {
  const area = visible ?? { x: 0, y: 0, w: page[0], h: page[1] };
  return { x: clamp(area.x + area.w / 2, 0, page[0]), y: clamp(area.y + area.h / 2, 0, page[1]) };
}

/** The arrow keys of the ghost: a step in x and y, `null` for any other key. */
export function ghostStep(key: string): Point | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 };
    case 'ArrowRight':
      return { x: 1, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -1 };
    case 'ArrowDown':
      return { x: 0, y: 1 };
    default:
      return null;
  }
}

/**
 * The text size that fits `face` into a box `w` by `h`: one line, the smaller of the height fit and the width fit, 6 to 72 pt. The
 * same numbers as `fitted_font` of the backend (`model/stamp.rs`).
 */
export function fittedFont(text: string, date: string | null, w: number, h: number): number {
  const PAD = 8;
  const DATE_SCALE = 0.6;
  const LINE_GAP = 0.2;
  const innerW = Math.max(1, w - 2 * Math.min(PAD, w / 4));
  const innerH = Math.max(1, h - 2 * Math.min(PAD, h / 4));
  const byHeight = innerH / (date === null ? 1 : 1 + LINE_GAP + DATE_SCALE);
  let unit = boldWidth(text, 1);
  if (date !== null) unit = Math.max(unit, textWidth(date, DATE_SCALE));
  const byWidth = unit > 0 ? innerW / unit : byHeight;
  return clamp(Math.min(byHeight, byWidth), 6, 72);
}

/** The font sizes and the baselines from the top (y down) of a stamp's text. */
export interface TextLayout {
  size: number;
  baseline: number;
  dateSize: number;
  dateBaseline: number;
}

/** The layout of a stamp's text in a box `w` by `h`: the font sizes and the baselines from the top (y down), as the appearance has them. */
export function textLayout(text: string, date: string | null, w: number, h: number): TextLayout {
  const CAP = 0.718;
  const size = fittedFont(text, date, w, h);
  if (date === null) return { size, baseline: h / 2 + (size * CAP) / 2, dateSize: 0, dateBaseline: 0 };
  const dateSize = size * 0.6;
  const block = size + size * 0.2 + dateSize;
  const bottom = (h - block) / 2;
  // The appearance has y up: convert the baselines (measured from the bottom) to y down.
  return {
    size,
    baseline: h - (bottom + dateSize + size * 0.2 + size * 0.2),
    dateSize,
    dateBaseline: h - (bottom + dateSize * 0.2),
  };
}

/** The tile that an arrow key moves to in a grid of `count` tiles in `columns` columns (no wrap); `null` for another key or the edge. */
export function gridTarget(key: string, index: number, count: number, columns: number): number | null {
  const step =
    key === 'ArrowLeft'
      ? -1
      : key === 'ArrowRight'
        ? 1
        : key === 'ArrowUp'
          ? -columns
          : key === 'ArrowDown'
            ? columns
            : 0;
  if (step === 0) return null;
  const target = index + step;
  if (target < 0 || target >= count) return null;
  // Left and Right stay in their row.
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && Math.floor(target / columns) !== Math.floor(index / columns))
    return null;
  return target;
}
