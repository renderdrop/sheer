import { HF_LIMITS, HF_SLOTS, type HfRefusal, type HfSlot, type HfSpec } from '../../api/headerFooter';
import type { Rgb } from '../../api/annotations';

/**
 * The dialog's model (DESIGN 3.15): each of the six places holds exactly one item (none, text, page number, date, file name), so
 * the draft is a small record that converts to the backend's `HfSpec` (slot strings with `{page}`, `{total}`, `{date}`, `{file}`
 * tokens) and back. Pure functions only; the dialog and the runtime read them.
 */

export type SlotKind = 'none' | 'text' | 'page' | 'date' | 'file';
export const SLOT_KINDS: readonly SlotKind[] = ['none', 'text', 'page', 'date', 'file'];

/** How a page number reads: `n` is "3", `pageN` "Page 3", `pageNofTotal` "Page 3 of 12", `nSlashTotal` "3 / 12". */
export type PageFormat = 'n' | 'pageN' | 'pageNofTotal' | 'nSlashTotal';
export const PAGE_FORMATS: readonly PageFormat[] = ['pageNofTotal', 'n', 'pageN', 'nSlashTotal'];

export interface SlotDraft {
  kind: SlotKind;
  /** The text of a `text` slot. */
  text: string;
  /** The format of a `page` slot. */
  format: PageFormat;
}

export interface Draft {
  slots: Record<HfSlot, SlotDraft>;
  /** The place the options row edits (the last focused trigger). */
  current: HfSlot;
  fontSize: number;
  margin: number;
  allPages: boolean;
  /** The range inputs, as typed. */
  from: string;
  to: string;
}

export const FONT_SIZES: readonly number[] = [8, 9, 10, 11, 12];
export const MARGINS: readonly number[] = [18, 24, 36];
export const DEFAULT_FONT_SIZE = 10;
export const DEFAULT_MARGIN = 24;
/** Characters a text slot takes (DESIGN 3.15 HF2); the backend allows 256 after escaping. */
export const TEXT_MAX = 80;

/** The rows and columns of the six places, in reading order (Tab order, HF7). */
export const HF_ROWS = [
  { id: 'header', slots: ['headerLeft', 'headerCenter', 'headerRight'] },
  { id: 'footer', slots: ['footerLeft', 'footerCenter', 'footerRight'] },
] as const satisfies readonly { id: string; slots: readonly HfSlot[] }[];

export type HfRow = 'header' | 'footer';
export type HfColumn = 'left' | 'centre' | 'right';
const COLUMNS: readonly HfColumn[] = ['left', 'centre', 'right'];

export function rowOf(slot: HfSlot): HfRow {
  return slot.startsWith('header') ? 'header' : 'footer';
}
export function columnOf(slot: HfSlot): HfColumn {
  return COLUMNS[HF_SLOTS.indexOf(slot) % 3] ?? 'left';
}

const NONE: SlotDraft = { kind: 'none', text: '', format: 'pageNofTotal' };

/** What a first dialog starts from (HF3): date in the footer left, "Page n of N" in the footer right. */
export function defaultDraft(): Draft {
  const slots = {} as Record<HfSlot, SlotDraft>;
  for (const slot of HF_SLOTS) slots[slot] = { ...NONE };
  slots.footerLeft = { ...NONE, kind: 'date' };
  slots.footerRight = { ...NONE, kind: 'page' };
  return {
    slots,
    current: 'footerRight',
    fontSize: DEFAULT_FONT_SIZE,
    margin: DEFAULT_MARGIN,
    allPages: true,
    from: '',
    to: '',
  };
}

// --- slot text <-> slot draft --------------------------------------------------------------------------------------------------

/** Braces in the user's text are doubled so that they are not read as tokens. */
export function escapeText(text: string): string {
  return text.replace(/[{}]/g, (c) => c + c);
}
export function unescapeText(text: string): string {
  return text.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

export type PatternLang = 'en' | 'de';
const WORDS: Record<PatternLang, { page: string; of: string }> = {
  en: { page: 'Page', of: 'of' },
  de: { page: 'Seite', of: 'von' },
};

/** The slot string of a page number format; the word follows the UI language. */
export function pagePattern(format: PageFormat, lang: PatternLang): string {
  const w = WORDS[lang];
  switch (format) {
    case 'n':
      return '{page}';
    case 'pageN':
      return `${w.page} {page}`;
    case 'pageNofTotal':
      return `${w.page} {page} ${w.of} {total}`;
    case 'nSlashTotal':
      return '{page} / {total}';
  }
}

export function serializeSlot(slot: SlotDraft, lang: PatternLang): string {
  switch (slot.kind) {
    case 'none':
      return '';
    case 'text':
      return escapeText(slot.text);
    case 'page':
      return pagePattern(slot.format, lang);
    case 'date':
      return '{date}';
    case 'file':
      return '{file}';
  }
}

/** Reads a slot string back (a spec loaded from the file). Anything that is not one of ours is a text slot. */
export function parseSlotText(value: string): SlotDraft {
  if (value === '') return { ...NONE };
  if (value === '{date}') return { ...NONE, kind: 'date' };
  if (value === '{file}') return { ...NONE, kind: 'file' };
  for (const lang of ['en', 'de'] as const) {
    for (const format of PAGE_FORMATS) {
      if (pagePattern(format, lang) === value) return { ...NONE, kind: 'page', format };
    }
  }
  return { ...NONE, kind: 'text', text: unescapeText(value).slice(0, TEXT_MAX) };
}

// --- page range ----------------------------------------------------------------------------------------------------------------

export interface RangeCheck {
  valid: boolean;
  /** The ranges text for the spec (`2-3`); `null` when invalid. */
  text: string | null;
  /** First and last page of the range; `null` when invalid. */
  first: number | null;
  last: number | null;
  /** Pages in the range. */
  count: number;
}

function wholeNumber(text: string): number | null {
  return /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;
}

/** Checks the From/To inputs against the page count: whole numbers from 1 to `total`, From not after To. Blank means the end. */
export function checkRange(from: string, to: string, total: number): RangeCheck {
  const invalid: RangeCheck = { valid: false, text: null, first: null, last: null, count: 0 };
  const first = from.trim() === '' ? 1 : wholeNumber(from);
  const last = to.trim() === '' ? total : wholeNumber(to);
  if (first === null || last === null || first < 1 || last > total || first > last) return invalid;
  return { valid: true, text: `${first}-${last}`, first, last, count: last - first + 1 };
}

/** Pages a `ranges` text covers when it is one simple range (`3`, `2-4`, `5-`); `null` for anything more complex. */
export function simpleRange(text: string, total: number): { from: number; to: number } | null {
  const match = /^\s*(\d{1,6})\s*(?:(-)\s*(\d{1,6})?)?\s*$/.exec(text);
  if (match === null) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : match[3] === undefined ? total : Number(match[3]);
  return from >= 1 && to <= total && from <= to ? { from, to } : null;
}

// --- draft <-> spec ------------------------------------------------------------------------------------------------------------

/** A draft from a spec the file carries. A range that is not one simple range falls back to all pages. */
export function draftFromSpec(spec: HfSpec, total: number): Draft {
  const slots = {} as Record<HfSlot, SlotDraft>;
  for (const slot of HF_SLOTS) slots[slot] = parseSlotText(spec.slots[slot]);
  const range = spec.pages.type === 'ranges' ? simpleRange(spec.pages.text, total) : null;
  return {
    slots,
    current: 'footerRight',
    fontSize: spec.fontSize,
    margin: spec.margin,
    allPages: range === null,
    from: range === null ? '' : String(range.from),
    to: range === null ? '' : String(range.to),
  };
}

/** Preselects a range (Pages mode with cards selected): first to last selected page, 1-based. */
export function withRange(draft: Draft, first: number, last: number): Draft {
  return { ...draft, allPages: false, from: String(first), to: String(last) };
}

export interface SpecContext {
  color: Rgb;
  /** The date as the UI formats it (`{date}`). */
  date: string;
  total: number;
  lang: PatternLang;
}

export function rangeOf(draft: Draft, total: number): RangeCheck {
  if (draft.allPages) return { valid: true, text: null, first: 1, last: total, count: total };
  return checkRange(draft.from, draft.to, total);
}

export function isEmpty(draft: Draft): boolean {
  return HF_SLOTS.every((slot) => draft.slots[slot].kind === 'none');
}

/** Whether Apply is possible: some place holds something, the range is valid and a text slot is not blank. */
export function canApply(draft: Draft, total: number): boolean {
  if (isEmpty(draft) || !rangeOf(draft, total).valid) return false;
  return HF_SLOTS.every((slot) => {
    const s = draft.slots[slot];
    return s.kind !== 'text' || (s.text.trim() !== '' && s.text.length <= TEXT_MAX);
  });
}

/** The spec to stage or to preview; `null` when the draft cannot be applied. */
export function buildSpec(draft: Draft, context: SpecContext): HfSpec | null {
  const range = rangeOf(draft, context.total);
  if (!range.valid) return null;
  const slots = {} as HfSpec['slots'];
  for (const slot of HF_SLOTS) slots[slot] = serializeSlot(draft.slots[slot], context.lang);
  return {
    slots,
    pages: range.text === null ? { type: 'all' } : { type: 'ranges', text: range.text },
    fontSize: clamp(draft.fontSize, HF_LIMITS.fontSize),
    margin: clamp(draft.margin, HF_LIMITS.margin),
    color: context.color,
    date: context.date.slice(0, HF_LIMITS.dateChars),
  };
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

/** No-break and narrow no-break space, which WinAnsi text in the page cannot take as written. */
const NARROW_SPACES = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`, 'g');

/** The date the dialog stores for `{date}`: today in the UI language's medium format, plain spaces, at most 32 characters. */
export function formatHfDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    .format(date)
    .replace(NARROW_SPACES, ' ')
    .slice(0, HF_LIMITS.dateChars);
}

/** The segments of a Segmented control: the standard values, plus the file's own value when it is not one of them. */
export function withValue(values: readonly number[], value: number): readonly number[] {
  return values.includes(value) ? values : [...values, value].sort((a, b) => a - b);
}

// --- refusal and undo ----------------------------------------------------------------------------------------------------------

/** The catalog key of the tooltip or toast that says why headers and footers cannot be changed (HF6). */
export function refusalKey(refusal: HfRefusal): 'hf.signed' | 'tool.readOnly' {
  return refusal === 'signed' ? 'hf.signed' : 'tool.readOnly';
}

/** The undo labels the backend sends for the two commands (catalog keys, `hf.undo` and `hf.undoRemove` in meaning). */
export const HF_UNDO_LABELS = { set: 'headerFooter.set', remove: 'headerFooter.remove' } as const;
