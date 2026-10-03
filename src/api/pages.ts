import { call } from './call';
import { toAppError, type ErrorCode } from './errors';

/**
 * The page model's commands (ARCHITECTURE section 5, "Pages", ADR-036). A page is named by its `PageId`, a number the backend never
 * reuses within a document: it is the file's page index when the document opens, and new pages get the next numbers, so an id stays
 * the same page through moves, rotations and undo. The backend reports the list in the current order.
 */

/** The most pages a document can have (`MAX_PAGES`). */
export const MAX_PAGES = 50_000;

/** The largest page side the backend reports, in points. */
export const MAX_PAGE_SIDE_PT = 14_400;

/** One page of a document in its current place. Sizes in points, before the rotation. */
export interface PageSlotInfo {
  id: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  /** Counts the changes that alter how the page looks; part of cache keys. */
  rev: number;
  label: string | null;
  origin: 'file' | 'blank' | 'imported';
}

/** The page commands; members of `DocCommand` (wire `{ type, ..fields }`). */
export type PageCommand =
  | { type: 'rotatePages'; pages: readonly number[]; quarterTurns: -1 | 1 | 2 }
  | { type: 'deletePages'; pages: readonly number[] }
  | { type: 'movePages'; pages: readonly number[]; toIndex: number }
  | { type: 'insertBlankPage'; at: number; width?: number; height?: number }
  | { type: 'insertPages'; source: number; pages: readonly number[]; at: number };

/** A PDF chosen to take pages from, or why it could not be read. */
export type SourceResult =
  | { type: 'ready'; sourceId: number; displayName: string; pageCount: number }
  | { type: 'failed'; code: ErrorCode; key: string; retryable?: boolean; params?: { what: string; limit?: number } };

const ROTATIONS: ReadonlySet<unknown> = new Set([0, 90, 180, 270]);
const ORIGINS: ReadonlySet<unknown> = new Set(['file', 'blank', 'imported']);

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isSide(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_PAGE_SIDE_PT;
}

/** One slot of an answer, or `null` if it is not one the backend sends. */
export function parseSlot(value: unknown): PageSlotInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, width, height, rotation, rev, label, origin } = value as Record<string, unknown>;
  if (
    !isUint(id) ||
    !isSide(width) ||
    !isSide(height) ||
    !ROTATIONS.has(rotation) ||
    !isUint(rev) ||
    !(label === null || typeof label === 'string') ||
    !ORIGINS.has(origin)
  )
    return null;
  return { id, width, height, rotation, rev, label, origin } as PageSlotInfo;
}

/** The list of an answer, or `null` if any slot is not one, the list is too long or an id repeats. */
export function parseSlots(value: unknown): PageSlotInfo[] | null {
  if (!Array.isArray(value) || value.length > MAX_PAGES) return null;
  const seen = new Set<number>();
  const slots: PageSlotInfo[] = [];
  for (const item of value as unknown[]) {
    const slot = parseSlot(item);
    if (slot === null || seen.has(slot.id)) return null;
    seen.add(slot.id);
    slots.push(slot);
  }
  return slots;
}

/** The pages of an open document in their current order. An answer that is not a page list is an internal error. */
export async function getPages(docId: number): Promise<PageSlotInfo[]> {
  const slots = parseSlots(await call<unknown>('get_pages', { docId }));
  if (slots === null) throw toAppError(null);
  return slots;
}

function parseSource(value: unknown): SourceResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'ready') {
    const { sourceId, displayName, pageCount } = item;
    if (!isUint(sourceId) || typeof displayName !== 'string' || !isUint(pageCount) || pageCount > MAX_PAGES)
      return null;
    return { type: 'ready', sourceId, displayName, pageCount };
  }
  if (item.type === 'failed' && typeof item.code === 'string' && typeof item.key === 'string') {
    return value as SourceResult;
  }
  return null;
}

/**
 * Asks the user for PDFs to take pages from (a native dialog in Rust, which reads them into memory). An empty list means the dialog
 * was cancelled. The UI only ever sees the id, the name and the page count of a source.
 */
export async function pickPdfSources(multiple: boolean): Promise<SourceResult[]> {
  const answer = await call<unknown>('pick_pdf_sources', { multiple });
  if (!Array.isArray(answer) || answer.length > 32) throw toAppError(null);
  const results: SourceResult[] = [];
  for (const item of answer as unknown[]) {
    const result = parseSource(item);
    if (result === null) throw toAppError(null);
    results.push(result);
  }
  return results;
}

/** Lets go of an import source. An id that is not held is nothing. */
export async function releaseSource(sourceId: number): Promise<void> {
  await call<void>('release_source', { sourceId });
}
