import { call } from './call';
import { toAppError } from './errors';
import { isRecord, isUint, parseRect, type Rect } from './wire';

/**
 * The links detected in the text of a page (ARCHITECTURE section 5, `smart_links`; src-tauri/src/commands/smart_links.rs, ADR-132,
 * DESIGN 3.11). Every one is a guess, shown as an overlay and never written into the PDF. Off is simply not calling this.
 */

/** Most links one page answers (`MAX_SMART_LINKS_PER_PAGE`). */
export const MAX_SMART_LINKS = 400;
/** Longest preview text in characters; the marker is cut at 120. */
export const MAX_PREVIEW_CHARS = 280;
export const MAX_MARKER_CHARS = 120;
export const MAX_LABEL_CHARS = 32;
/** Most boxes of one link (a contents line has two: the number and the whole line). */
const MAX_RECTS = 8;

export type SmartLinkKind = 'footnote' | 'noteBack' | 'contents' | 'reference' | 'literature';
const KINDS: readonly unknown[] = ['footnote', 'noteBack', 'contents', 'reference', 'literature'];

/** Where a smart link goes: a page of the document and, when known, the box of the target lines (note, entry, caption, heading). */
export interface SmartTarget {
  pageId: number;
  rect?: Rect;
  /** The page number as printed at the source link (a contents line, a page reference), when it names one. */
  label?: string;
}

/**
 * One detected link. `rects` are in page space (points, top left, before `/Rotate`): the source run, or for `contents` the page
 * number (draw the cue there) followed by the whole line (the hit area). `marker` is the marker text, the label or the contents title;
 * `preview` is the target's text cut to 280 characters ("" for a bare page target). Both are the document's: render them as text.
 */
export interface SmartLink {
  kind: SmartLinkKind;
  rects: Rect[];
  marker: string;
  target: SmartTarget;
  preview: string;
  /** Only on a range run ("[3-5]", DESIGN 3.11 L14): the resolved numbers, ascending, at least two; `target` is the first one's. */
  choices?: SmartChoice[];
}

/** One resolved number of a range run: its entry (cut to 120 characters) and where it is. */
export interface SmartChoice {
  number: number;
  preview: string;
  target: SmartTarget;
}

/** Most numbers a range run lists (the backend refuses wider ranges) and the longest choice preview in characters. */
export const MAX_CHOICES = 50;
export const MAX_CHOICE_PREVIEW_CHARS = 120;

/**
 * The answer of `smart_links`: `rev` is the document revision the links are for (drop them when the revision moves on), `ready` is
 * false while the document index is still being built (`links` is empty then: ask again after a moment).
 */
export interface SmartLinksResult {
  rev: number;
  ready: boolean;
  /** The index hit its time or size limit: pages after the last one read have no links. */
  partial?: boolean;
  links: SmartLink[];
}

function parseTarget(value: unknown): SmartTarget | null {
  if (!isRecord(value) || !isUint(value.pageId)) return null;
  const { label } = value;
  if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > MAX_LABEL_CHARS))
    return null;
  const named = typeof label === 'string' && label !== '' ? { label } : {};
  if (value.rect === undefined || value.rect === null) return { pageId: value.pageId, ...named };
  const rect = parseRect(value.rect);
  return rect === null ? null : { pageId: value.pageId, rect, ...named };
}

function parseLink(value: unknown): SmartLink | null {
  if (!isRecord(value)) return null;
  const { kind, rects, marker, preview } = value;
  if (!KINDS.includes(kind)) return null;
  if (!Array.isArray(rects) || rects.length === 0 || rects.length > MAX_RECTS) return null;
  if (typeof marker !== 'string' || marker.length > MAX_MARKER_CHARS) return null;
  if (typeof preview !== 'string' || preview.length > MAX_PREVIEW_CHARS) return null;
  const boxes: Rect[] = [];
  for (const raw of rects as unknown[]) {
    const rect = parseRect(raw);
    if (rect === null) return null;
    boxes.push(rect);
  }
  const target = parseTarget(value.target);
  if (target === null) return null;
  const base = { kind: kind as SmartLinkKind, rects: boxes, marker, target, preview };
  if (value.choices === undefined || value.choices === null) return base;
  const choices = parseChoices(value.choices);
  return choices === null ? null : { ...base, choices };
}

function parseChoices(value: unknown): SmartChoice[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_CHOICES) return null;
  const out: SmartChoice[] = [];
  let last = 0;
  for (const raw of value as unknown[]) {
    if (!isRecord(raw) || !isUint(raw.number) || raw.number <= last) return null;
    if (typeof raw.preview !== 'string' || Array.from(raw.preview).length > MAX_CHOICE_PREVIEW_CHARS) return null;
    const target = parseTarget(raw.target);
    if (target === null) return null;
    last = raw.number;
    out.push({ number: raw.number, preview: raw.preview, target });
  }
  return out;
}

/**
 * Validates the answer of `smart_links`: a revision, the ready flag, and at most 400 links of the documented shape. `null` if it is
 * not that; extra keys are dropped.
 */
export function parseSmartLinks(value: unknown): SmartLinksResult | null {
  if (!isRecord(value)) return null;
  const { rev, ready, links } = value;
  if (!isUint(rev, Number.MAX_SAFE_INTEGER) || typeof ready !== 'boolean') return null;
  if (!Array.isArray(links) || links.length > MAX_SMART_LINKS) return null;
  const parsed: SmartLink[] = [];
  for (const item of links as unknown[]) {
    const link = parseLink(item);
    if (link === null) return null;
    parsed.push(link);
  }
  return { rev, ready, ...(typeof value.partial === 'boolean' ? { partial: value.partial } : {}), links: parsed };
}

/**
 * The smart links of a page of an open document. An answer that does not have the documented shape is an internal error. Rejects with
 * `invalid_argument` for a page the document does not have and `not_found` for a document that is not open.
 */
export async function getSmartLinks(docId: number, pageId: number): Promise<SmartLinksResult> {
  const result = parseSmartLinks(await call<unknown>('smart_links', { docId, pageId }));
  if (result === null) throw toAppError(null);
  return result;
}
