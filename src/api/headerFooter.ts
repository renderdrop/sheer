import { applyCommand, type ChangeSet, type Rgb } from './annotations';
import { call } from './call';
import { toAppError } from './errors';
import type { PageId } from './jobs';
import { isRecord, isUint, parsePoint, type Point } from './wire';

/**
 * Headers and footers (ADR-139, ARCHITECTURE section 16.2 and 16.5). The spec is staged by `setHeaderFooter` (one undo step) and
 * written at the next save as a marked page-content layer; `getHeaderFooter` and `resolveHeaderFooter` read. Every answer goes
 * through a parser here; a wrong shape is an `internal` error.
 */

export const HF_SLOTS = [
  'headerLeft',
  'headerCenter',
  'headerRight',
  'footerLeft',
  'footerCenter',
  'footerRight',
] as const;
export type HfSlot = (typeof HF_SLOTS)[number];

/** The text of the six places; `''` is none. Tokens `{page}`, `{total}`, `{date}`, `{file}`; `{{` and `}}` are braces. */
export type HfSlots = Record<HfSlot, string>;

/** Which pages get the text: all, or ranges like `1-3, 5, 8-` (positions in the saved file). */
export type HfPages = { type: 'all' } | { type: 'ranges'; text: string };

export interface HfSpec {
  slots: HfSlots;
  pages: HfPages;
  /** Points, 6 to 24. */
  fontSize: number;
  /** Points from the shown edge, 12 to 72. */
  margin: number;
  color: Rgb;
  /** What `{date}` is, formatted by the UI (at most 32 WinAnsi characters). */
  date: string;
}

/** Limits the backend enforces; mirrored so the dialog can stop typing early. */
export const HF_LIMITS = {
  slotChars: 256,
  dateChars: 32,
  rangesChars: 256,
  fontSize: [6, 24],
  margin: [12, 72],
  resolvePages: 64,
} as const;

/** Why a change would be refused (`read_only` `what`). */
export type HfRefusal = 'signed' | 'permission';

export interface HeaderFooterInfo {
  /** The current spec, a staged one included; `null` when the document has none. */
  spec: HfSpec | null;
  /** What a new dialog starts from (date left, page number right in the footer). */
  defaults: HfSpec;
  /** A change is staged and not saved. */
  pending: boolean;
  /** Pages of the file that carry a layer of ours. */
  fileLayers: number;
  refusal: HfRefusal | null;
}

/** One line of text at its place on one page. */
export interface PlacedRun {
  text: string;
  /** Start of the baseline in page space (top left of the unrotated crop box, y down). */
  origin: Point;
  /** Degrees clockwise the text is turned in page space so that it reads upright on the displayed page. */
  angle: number;
  size: number;
  width: number;
}

export interface ResolvedPage {
  pageId: PageId;
  runs: PlacedRun[];
  /** The engine's copy of the page still shows a layer of the file (it is replaced at save): the overlay skips such a page. */
  underFileLayer: boolean;
}

export type SetHeaderFooterCommand = { type: 'setHeaderFooter'; spec: HfSpec | null };

function bad(what: string): never {
  throw toAppError(new Error(`headerFooter: unexpected ${what}`));
}

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isUint(r, 255) && isUint(g, 255) && isUint(b, 255) ? [r, g, b] : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseHfSpec(value: unknown): HfSpec | null {
  if (!isRecord(value) || !isRecord(value.slots) || !isRecord(value.pages)) return null;
  const slots = {} as HfSlots;
  for (const slot of HF_SLOTS) {
    const text = value.slots[slot];
    if (typeof text !== 'string') return null;
    slots[slot] = text;
  }
  let pages: HfPages;
  if (value.pages.type === 'all') pages = { type: 'all' };
  else if (value.pages.type === 'ranges' && typeof value.pages.text === 'string') {
    pages = { type: 'ranges', text: value.pages.text };
  } else return null;
  const color = parseRgb(value.color);
  if (!finite(value.fontSize) || !finite(value.margin) || color === null || typeof value.date !== 'string') return null;
  return { slots, pages, fontSize: value.fontSize, margin: value.margin, color, date: value.date };
}

export function parseHeaderFooterInfo(value: unknown): HeaderFooterInfo {
  if (!isRecord(value)) return bad('info');
  const spec = value.spec === null ? null : parseHfSpec(value.spec);
  const defaults = parseHfSpec(value.defaults);
  const { refusal } = value;
  if (
    (value.spec !== null && spec === null) ||
    defaults === null ||
    typeof value.pending !== 'boolean' ||
    !isUint(value.fileLayers) ||
    (refusal !== null && refusal !== 'signed' && refusal !== 'permission')
  ) {
    return bad('info');
  }
  return { spec, defaults, pending: value.pending, fileLayers: value.fileLayers, refusal };
}

function parseRun(value: unknown): PlacedRun {
  if (!isRecord(value)) return bad('run');
  const origin = parsePoint(value.origin);
  if (
    typeof value.text !== 'string' ||
    origin === null ||
    !isUint(value.angle, 359) ||
    !finite(value.size) ||
    !finite(value.width)
  ) {
    return bad('run');
  }
  return { text: value.text, origin, angle: value.angle, size: value.size, width: value.width };
}

export function parseResolvedPages(value: unknown): ResolvedPage[] {
  if (!Array.isArray(value) || value.length > HF_LIMITS.resolvePages) return bad('pages');
  return value.map((entry): ResolvedPage => {
    if (
      !isRecord(entry) ||
      !isUint(entry.pageId) ||
      !Array.isArray(entry.runs) ||
      typeof entry.underFileLayer !== 'boolean'
    ) {
      return bad('page');
    }
    return { pageId: entry.pageId, runs: entry.runs.map(parseRun), underFileLayer: entry.underFileLayer };
  });
}

/** The current headers and footers of the document, and whether a change would be refused. The first call reads the file. */
export async function getHeaderFooter(docId: number): Promise<HeaderFooterInfo> {
  return parseHeaderFooterInfo(await call<unknown>('get_header_footer', { docId }));
}

/**
 * The runs `spec` would put on `pages` (1 to 64): what the save writes, for the dialog preview and the overlay. `spec` `null`
 * means the current one. A spec that does not fit is `invalid_argument` (`headerFooter` with `params.char`, `ranges`, ...).
 */
export async function resolveHeaderFooter(
  docId: number,
  spec: HfSpec | null,
  pages: readonly PageId[],
): Promise<ResolvedPage[]> {
  return parseResolvedPages(await call<unknown>('resolve_header_footer', { docId, spec, pages }));
}

/** Stages `spec` (`null` removes the headers and footers) as one undo step; the next save writes it. `changes.doc` has `headerFooter`. */
export function setHeaderFooter(docId: number, spec: HfSpec | null): Promise<ChangeSet> {
  return applyCommand(docId, { type: 'setHeaderFooter', spec });
}
