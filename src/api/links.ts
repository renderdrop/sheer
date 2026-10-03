import { call } from './call';
import { toAppError } from './errors';
import { isCoordinate, isRecord, isUint, parseRect, type Rect } from './wire';

/**
 * The links of a page and opening one (ARCHITECTURE section 5, `get_page_links`, `open_link`; src-tauri/src/commands/links.rs,
 * SECURITY P2, P3). The UI never holds a URL it could open: `open_link` names a link by its place, the backend reads the URL
 * from the document again, asks the user in a native dialog and opens it. Nothing a PDF asks for is done.
 */

/** Most links of one page (`MAX_PAGE_LINKS`). */
export const MAX_PAGE_LINKS = 1_000;
/** Longest URL of a link in bytes (`MAX_URL_LEN`); a URL is ASCII. */
export const MAX_URL_LEN = 2048;

/**
 * Where a link goes: a place in this document (`page`, scroll there), a web or mail address (`url`: plain `http`, `https` or
 * `mailto`, at most 2048 bytes, for display: render it as text only), or nowhere the app goes (`blocked`: a program to launch, a
 * jump to another file, JavaScript, any other kind of URL; show it as a link that does nothing).
 */
export type LinkTarget =
  { type: 'page'; pageId: number; y: number } | { type: 'url'; url: string } | { type: 'blocked' };

/** A link of a page: its place in the page's list (what `openLink` names it by), where it can be clicked, and where it goes. */
export interface LinkInfo {
  index: number;
  rect: Rect;
  target: LinkTarget;
}

/** The address of a link as the backend lets it through: printable ASCII only, starting `http://`, `https://` or `mailto:`. */
const URL_SHAPE = /^(?:https?:\/\/|mailto:)[\x21-\x7e]*$/i;

function parseTarget(value: unknown): LinkTarget | null {
  if (!isRecord(value)) return null;
  const { type } = value;
  if (type === 'blocked') return { type };
  if (type === 'page') {
    const { pageId, y } = value;
    return isUint(pageId) && isCoordinate(y) && y >= 0 ? { type, pageId, y } : null;
  }
  if (type === 'url') {
    const { url } = value;
    return typeof url === 'string' && url.length <= MAX_URL_LEN && URL_SHAPE.test(url) ? { type, url } : null;
  }
  return null;
}

/**
 * Validates the answer of `get_page_links`: at most 1 000 links, in the order of their indices (0, 1, 2, ...), each with a
 * rectangle and a target. `null` if it is not a list of links; extra keys are dropped.
 */
export function parsePageLinks(value: unknown): LinkInfo[] | null {
  if (!Array.isArray(value) || value.length > MAX_PAGE_LINKS) return null;
  const links: LinkInfo[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null;
    const { index } = item;
    const rect = parseRect(item.rect);
    const target = parseTarget(item.target);
    if (index !== links.length || rect === null || target === null) return null;
    links.push({ index, rect, target });
  }
  return links;
}

/**
 * The links of a page of an open document, in the order that gives each its `index`. An answer that does not have the documented
 * shape is an internal error. Rejects with `invalid_argument` for a page the document does not have and `not_found` for a
 * document that is not open.
 */
export async function getPageLinks(docId: number, pageId: number): Promise<LinkInfo[]> {
  const links = parsePageLinks(await call<unknown>('get_page_links', { docId, pageId }));
  if (links === null) throw toAppError(null);
  return links;
}

/**
 * Opens link `linkIndex` of a page: the backend reads the URL from the document, shows it in full in a native dialog and opens it
 * if the user agrees (the system's browser or mail program). Resolves when the user has decided; nothing happens, and nothing is
 * reported, if the user declines. Rejects with `invalid_argument` (`link`) for a link that does not exist, goes to a page or is
 * blocked: there is nothing to open then (the UI scrolls to a `page` target itself).
 */
export function openLink(docId: number, pageId: number, linkIndex: number): Promise<void> {
  return call<void>('open_link', { docId, pageId, linkIndex });
}
