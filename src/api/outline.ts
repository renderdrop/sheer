import { call } from './call';
import { toAppError } from './errors';
import { isCoordinate, isRecord, isUint } from './wire';

/**
 * The outline (bookmarks) of a document (ARCHITECTURE section 5, `get_outline`; src-tauri/src/commands/outline.rs). The bounds are
 * the backend's (`limits.rs`); a longer or deeper answer is not one of its.
 */

/** Most nodes in an outline (`MAX_OUTLINE_NODES`). */
export const MAX_OUTLINE_NODES = 10_000;
/** Most levels in an outline, the top level being 1 (`MAX_OUTLINE_DEPTH`). */
export const MAX_OUTLINE_DEPTH = 32;
/** Longest title in characters (`MAX_OUTLINE_TITLE_CHARS`). */
export const MAX_OUTLINE_TITLE_CHARS = 512;

/** A place on a page: the page's id and how far down it, in points from the top of the page's box. */
export interface OutlineTarget {
  pageId: number;
  y: number;
}

/**
 * One entry of the outline. `title` comes from the file: the backend took out the characters that reorder or hide text, but it
 * is still text of the document, to be rendered as text only. `target` is where the entry goes if that is a page of the
 * document; `null` for an entry that opens something else, or only groups its children.
 */
export interface OutlineNode {
  title: string;
  target: OutlineTarget | null;
  children: OutlineNode[];
  /** Made from the headings of a document without bookmarks (ADR-113), not stored in the file. */
  derived: boolean;
}

/** Characters as the backend counts them (code points), not UTF-16 code units. */
function characterCount(text: string): number {
  return Array.from(text).length;
}

function parseTarget(value: unknown): OutlineTarget | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { pageId, y } = value;
  return isUint(pageId) && isCoordinate(y) && y >= 0 ? { pageId, y } : undefined;
}

/** Reads one level; `budget.left` counts the nodes that may still be read. `undefined` when something is not as documented. */
function parseLevel(value: unknown, depth: number, budget: { left: number }): OutlineNode[] | undefined {
  // A node is at most on level 32; the empty list of children below the last level is fine.
  if (!Array.isArray(value) || (depth > MAX_OUTLINE_DEPTH && value.length > 0)) return undefined;
  const nodes: OutlineNode[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || budget.left <= 0) return undefined;
    budget.left -= 1;
    const { title, target, children, derived = false } = item;
    if (typeof derived !== 'boolean' || typeof title !== 'string' || title.length > MAX_OUTLINE_TITLE_CHARS * 2)
      return undefined;
    if (characterCount(title) > MAX_OUTLINE_TITLE_CHARS) return undefined;
    const parsedTarget = parseTarget(target);
    const parsedChildren = parseLevel(children, depth + 1, budget);
    if (parsedTarget === undefined || parsedChildren === undefined) return undefined;
    nodes.push({ title, target: parsedTarget, children: parsedChildren, derived });
  }
  return nodes;
}

/**
 * Validates the answer of `get_outline`: at most 10 000 nodes down to 32 levels, a title of at most 512 characters, a target that
 * is a page id and a position. `null` if it is not an outline; extra keys are dropped.
 */
export function parseOutline(value: unknown): OutlineNode[] | null {
  return parseLevel(value, 1, { left: MAX_OUTLINE_NODES }) ?? null;
}

/**
 * The outline of an open document, in document order; empty if it has none. An answer that does not have the documented shape is
 * an internal error. Rejects with `not_found` for a document that is not open.
 */
export async function getOutline(docId: number): Promise<OutlineNode[]> {
  const outline = parseOutline(await call<unknown>('get_outline', { docId }));
  if (outline === null) throw toAppError(null);
  return outline;
}
