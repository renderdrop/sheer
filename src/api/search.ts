import { Channel } from '@tauri-apps/api/core';

import { call } from './call';
import { toAppError, type AppError } from './errors';
import { MAX_PAGES } from './render';
import { isRecord, isUint, parseQuad, type Quad } from './wire';

/**
 * Searching a document (ARCHITECTURE section 5, `search`, `cancel_search`; src-tauri/src/commands/search.rs): the backend searches
 * page by page at a low priority, so pages that are on screen are drawn first, and streams what it finds on a `Channel` that is
 * passed to the command (the window has no event permission, SECURITY T3).
 */

/** Longest search text in characters (`MAX_SEARCH_QUERY_CHARS`). */
export const MAX_SEARCH_QUERY_CHARS = 512;
/** Most hits one search reports (`MAX_SEARCH_HITS`). */
export const MAX_SEARCH_HITS = 50_000;
/** Most rectangles in one hit (`MAX_QUADS_PER_HIT`). */
export const MAX_QUADS_PER_HIT = 512;
/** What to search for. The text is 1 to 512 characters and is not only white space. */
export interface SearchQuery {
  text: string;
  /** Upper and lower case are different letters. Default `false`: the case of every letter is Unicode's, not ASCII's only. */
  matchCase?: boolean;
  /** A hit is a whole word. Default `false`. */
  wholeWord?: boolean;
  /** The search stops at this many hits (1 to 50 000; default 50 000). */
  maxHits?: number;
}

/**
 * One message of a search. Pages come in page order with the hits of the pages that have any: `hits` has, for each hit, the quads
 * of the text it covers (one for each line it runs over, in page space). `progress` is not sent after every page. `done` ends the
 * search: `truncated` says it stopped at `maxHits`, so there may be more. `failed` ends it too (the engine could not go on), and
 * then no `done` follows. A search that was cancelled sends nothing more.
 */
export type SearchEvent =
  | { type: 'hits'; pageId: number; hits: Quad[][] }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; truncated: boolean }
  | { type: 'failed'; error: AppError };

function parseHits(value: unknown): Quad[][] | null {
  if (!Array.isArray(value) || value.length > MAX_SEARCH_HITS) return null;
  const hits: Quad[][] = [];
  for (const hit of value as unknown[]) {
    if (!Array.isArray(hit) || hit.length === 0 || hit.length > MAX_QUADS_PER_HIT) return null;
    const quads: Quad[] = [];
    for (const quad of hit as unknown[]) {
      const parsed = parseQuad(quad);
      if (parsed === null) return null;
      quads.push(parsed);
    }
    hits.push(quads);
  }
  return hits;
}

/** A search message from a channel; `null` if it is not one. Extra keys are dropped. */
export function parseSearchEvent(message: unknown): SearchEvent | null {
  if (!isRecord(message)) return null;
  const { type } = message;
  if (type === 'hits') {
    const { pageId } = message;
    const hits = parseHits(message.hits);
    return isUint(pageId) && hits !== null ? { type, pageId, hits } : null;
  }
  if (type === 'progress') {
    const { done, total } = message;
    return isUint(done, MAX_PAGES) && isUint(total, MAX_PAGES) && done <= total ? { type, done, total } : null;
  }
  if (type === 'done') {
    return typeof message.truncated === 'boolean' ? { type, truncated: message.truncated } : null;
  }
  // The error sits flat in the message, next to `type`, as in `openFailed`.
  if (type === 'failed') return { type, error: toAppError(message) };
  return null;
}

/** The searches that are running, by the id the backend gave: `cancelSearch` closes them, so a message in flight is not delivered. */
const running = new Map<number, SearchState>();
/** The current search of each document: a new one closes it. */
const current = new Map<number, SearchState>();

interface SearchState {
  closed: boolean;
  id: number | null;
  docId: number;
  /** Hits delivered so far, over all messages. */
  hits: number;
}

/** Closes a search for good: nothing more is delivered, and it is not remembered. */
function close(state: SearchState): void {
  state.closed = true;
  if (state.id !== null && running.get(state.id) === state) running.delete(state.id);
  if (current.get(state.docId) === state) current.delete(state.docId);
}

/**
 * Starts a search of an open document and resolves to its id at once; `onEvent` then gets the messages as the pages are searched,
 * ending with `done` or `failed`. A document has one search at a time: starting another cancels the one before it in the backend,
 * which then goes quiet. Rejects with `invalid_argument` (`query`, `hits`) for an empty text or no hits wanted, `limit_exceeded`
 * (`query`, `hits`, `searches`) beyond the limits, and `not_found` for a document that is not open.
 */
export async function search(
  docId: number,
  query: SearchQuery,
  onEvent: (event: SearchEvent) => void,
): Promise<number> {
  // A new search of the document closes the one before it: what that has in flight is never delivered.
  const previous = current.get(docId);
  if (previous !== undefined) close(previous);
  const state: SearchState = { closed: false, id: null, docId, hits: 0 };
  current.set(docId, state);
  const finish = (event: SearchEvent) => {
    close(state);
    onEvent(event);
  };
  const channel = new Channel<unknown>((message) => {
    if (state.closed) return;
    const event = parseSearchEvent(message);
    if (event === null) {
      // A last message that cannot be read must not leave the caller waiting for ever.
      if (isRecord(message) && (message.type === 'done' || message.type === 'failed')) {
        finish({ type: 'failed', error: toAppError(null) });
      }
      return;
    }
    if (event.type === 'hits') {
      const room = MAX_SEARCH_HITS - state.hits;
      if (event.hits.length > room) {
        // More hits than one search reports: what fits is delivered, then the search ends as truncated.
        const id = state.id;
        if (room > 0) onEvent({ ...event, hits: event.hits.slice(0, room) });
        finish({ type: 'done', truncated: true });
        if (id !== null) call<void>('cancel_search', { searchId: id }).catch(() => undefined);
        return;
      }
      state.hits += event.hits.length;
    }
    // The last message of a search: nothing follows it.
    if (event.type === 'done' || event.type === 'failed') finish(event);
    else onEvent(event);
  });
  let id: unknown;
  try {
    id = await call<unknown>('search', {
      docId,
      query: {
        text: query.text,
        matchCase: query.matchCase ?? false,
        wholeWord: query.wholeWord ?? false,
        maxHits: query.maxHits ?? MAX_SEARCH_HITS,
      },
      onEvent: channel,
    });
  } catch (error) {
    close(state);
    throw error;
  }
  if (!isUint(id)) {
    close(state);
    throw toAppError(null);
  }
  state.id = id;
  if (!state.closed) running.set(id, state);
  return id;
}

/**
 * Stops a search: nothing it has in flight is delivered after this returns. A search that is over, or unknown, is not an error.
 * The UI cancels when its panel closes; starting a new search of the same document cancels the old one by itself.
 */
export async function cancelSearch(searchId: number): Promise<void> {
  const state = running.get(searchId);
  if (state !== undefined) close(state);
  await call<void>('cancel_search', { searchId });
}

/** How many searches are remembered (for tests: it must not grow with the number of searches). */
export function trackedSearchCount(): number {
  return running.size + current.size;
}
