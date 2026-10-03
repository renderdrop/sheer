import { create } from 'zustand';

import { toAppError, type AppError } from '../../api/errors';
import { cancelSearch, search, type SearchEvent } from '../../api/search';
import type { Quad } from '../../api/wire';
import { useDocuments } from '../../stores/documents';

/**
 * Searching the open documents (DESIGN 3.16, ADR-026). One search state per document, in memory: the query, the options, the hits
 * as the pages finish, and which hit is active. The hits are drawn by the pages (`SearchHits`), each of which subscribes to the
 * hits of its own page only, so a new hit or another active one wakes the pages it concerns and not the document.
 */

/** Typing searches after this long without a key, from `SEARCH_MIN_CHARS` characters. */
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;
/** The UI asks Rust for no more hits than this (ADR-026); more is reported as "10 000+". */
export const SEARCH_MAX_HITS = 10_000;
/** The longest query the field takes, in characters (DESIGN 3.16). */
export const SEARCH_MAX_CHARS = 256;

/** One hit: the quads of the text it covers, in page space. `index` is its position in the order of the document. */
export interface Hit {
  index: number;
  page: number;
  quads: readonly Quad[];
}

export type SearchStatus = 'idle' | 'running' | 'done' | 'failed';

export interface SearchEntry {
  /** What the field holds. */
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  status: SearchStatus;
  /** Counts the searches of this document; a new search is a new run (the row snippets belong to one run). */
  runId: number;
  /** The query the hits belong to (`''` before the first search). It differs from `text` while a new one is pending. */
  ran: string;
  hits: readonly Hit[];
  /** The hits of each page that has any. A page's array is replaced only when that page gets hits. */
  pageHits: Readonly<Record<number, readonly Hit[]>>;
  pageCount: number;
  /** The search stopped at the limit: there may be more. */
  truncated: boolean;
  progress: { done: number; total: number } | null;
  /** The active hit, `-1` for none. */
  active: number;
  /** The user has moved to a hit (next, previous, a click): the live region says the position and not the count. */
  stepped: boolean;
  error: AppError | null;
}

const EMPTY: SearchEntry = {
  text: '',
  matchCase: false,
  wholeWord: false,
  status: 'idle',
  runId: 0,
  ran: '',
  hits: [],
  pageHits: {},
  pageCount: 0,
  truncated: false,
  progress: null,
  active: -1,
  stepped: false,
  error: null,
};

/** The entry of a document that has none yet. */
export const NO_SEARCH: SearchEntry = EMPTY;

/** Whether `text` can be searched at all (not empty or white space only). */
export function isSearchable(text: string): boolean {
  return text.trim() !== '';
}

export interface SearchState {
  byDoc: Readonly<Record<number, SearchEntry>>;
  /** Counts the requests to focus the field (Find): the panel focuses it when this changes. */
  focusRequest: number;

  /** The field changed: searches after the debounce from two characters; an empty field clears the results. */
  setText: (docId: number, text: string) => void;
  /** Enter in the field: searches now if the field holds a query that has not been searched and says so; else the caller steps. */
  submit: (docId: number) => boolean;
  setOptions: (docId: number, options: { matchCase?: boolean; wholeWord?: boolean }) => void;
  /** Searches again (after a failure). */
  retry: (docId: number) => void;
  /** Removes the results and the query. */
  clear: (docId: number) => void;
  /** Moves the active hit by `direction`, wrapping; reports the hit to go to, or `null` when there are none. */
  step: (docId: number, direction: 1 | -1) => Hit | null;
  /** Makes a hit the active one (a click or Enter on a row); returns it. */
  activate: (docId: number, index: number) => Hit | null;
  /** Asks the panel to focus and select its field. */
  requestFocus: () => void;
  /** Forgets a closed document. */
  drop: (docId: number) => void;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const searchIds = new Map<number, number>();
/** Counts the searches of each document, so a message of an old one is never taken for the new one's. */
const generations = new Map<number, number>();
let watching = false;

function stopTimer(docId: number): void {
  const timer = timers.get(docId);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(docId);
}

/** The running search of a document is cancelled; what it has in flight is never delivered. */
function stopSearch(docId: number): void {
  stopTimer(docId);
  generations.set(docId, (generations.get(docId) ?? 0) + 1);
  const id = searchIds.get(docId);
  searchIds.delete(docId);
  if (id !== undefined) cancelSearch(id).catch(() => undefined);
}

export const useSearch = create<SearchState>()((set, get) => {
  const entryOf = (docId: number): SearchEntry => get().byDoc[docId] ?? EMPTY;
  const patch = (docId: number, change: (entry: SearchEntry) => SearchEntry) =>
    set((state) => ({ byDoc: { ...state.byDoc, [docId]: change(state.byDoc[docId] ?? EMPTY) } }));

  const onEvent = (docId: number, generation: number, event: SearchEvent) => {
    if (generations.get(docId) !== generation) return;
    if (event.type === 'hits') {
      patch(docId, (entry) => {
        if (entry.status !== 'running') return entry;
        const first = entry.hits.length;
        const added = event.hits.map((quads, offset): Hit => ({ index: first + offset, page: event.pageId, quads }));
        if (added.length === 0) return entry;
        const hits = entry.hits.concat(added);
        const pageHits = {
          ...entry.pageHits,
          [event.pageId]: (entry.pageHits[event.pageId] ?? []).concat(added),
        };
        // The first hit becomes active without scrolling (DESIGN 3.16).
        return {
          ...entry,
          hits,
          pageHits,
          pageCount: Object.keys(pageHits).length,
          active: entry.active < 0 ? 0 : entry.active,
        };
      });
    } else if (event.type === 'progress') {
      patch(docId, (entry) => (entry.status === 'running' ? { ...entry, progress: event } : entry));
    } else if (event.type === 'done') {
      searchIds.delete(docId);
      patch(docId, (entry) => ({
        ...entry,
        status: 'done',
        progress: null,
        truncated: event.truncated || entry.hits.length >= SEARCH_MAX_HITS,
      }));
    } else {
      searchIds.delete(docId);
      patch(docId, (entry) => ({ ...entry, status: 'failed', progress: null, error: event.error }));
    }
  };

  /** Starts the search of the current text and options. */
  const run = (docId: number) => {
    stopSearch(docId);
    const entry = entryOf(docId);
    if (!isSearchable(entry.text)) return;
    const generation = generations.get(docId) ?? 0;
    set((state) => ({
      byDoc: {
        ...state.byDoc,
        [docId]: {
          ...entry,
          status: 'running',
          runId: generation,
          ran: entry.text,
          hits: [],
          pageHits: {},
          pageCount: 0,
          truncated: false,
          progress: null,
          active: -1,
          stepped: false,
          error: null,
        },
      },
    }));
    search(
      docId,
      { text: entry.text, matchCase: entry.matchCase, wholeWord: entry.wholeWord, maxHits: SEARCH_MAX_HITS },
      (event) => onEvent(docId, generation, event),
    ).then(
      (id) => {
        if (generations.get(docId) === generation) searchIds.set(docId, id);
        else cancelSearch(id).catch(() => undefined);
      },
      (caught: unknown) => {
        if (generations.get(docId) !== generation) return;
        patch(docId, (current) => ({ ...current, status: 'failed', progress: null, error: toAppError(caught) }));
      },
    );
  };

  const watchDocuments = () => {
    if (watching) return;
    watching = true;
    useDocuments.subscribe((state) => {
      for (const id of Object.keys(get().byDoc)) {
        if (state.byId[Number(id)] === undefined) get().drop(Number(id));
      }
    });
  };

  const schedule = (docId: number) => {
    stopTimer(docId);
    timers.set(
      docId,
      setTimeout(() => {
        timers.delete(docId);
        run(docId);
      }, SEARCH_DEBOUNCE_MS),
    );
  };

  /** Clears the results and stops the search; keeps the text and the options as they are. */
  const reset = (docId: number, keep: Partial<SearchEntry>) => {
    stopSearch(docId);
    patch(docId, (entry) => ({ ...EMPTY, matchCase: entry.matchCase, wholeWord: entry.wholeWord, ...keep }));
  };

  return {
    byDoc: {},
    focusRequest: 0,

    setText: (docId, raw) => {
      watchDocuments();
      const text = raw.slice(0, SEARCH_MAX_CHARS);
      if (text === entryOf(docId).text) return;
      if (!isSearchable(text)) {
        // Cleared: the results go with it.
        reset(docId, { text });
        return;
      }
      patch(docId, (entry) => ({ ...entry, text }));
      if (text.length >= SEARCH_MIN_CHARS) schedule(docId);
      else stopTimer(docId);
    },

    submit: (docId) => {
      const entry = entryOf(docId);
      if (!isSearchable(entry.text)) return true;
      const pending = entry.text !== entry.ran || entry.status === 'idle';
      if (pending) run(docId);
      return pending;
    },

    setOptions: (docId, options) => {
      watchDocuments();
      const entry = entryOf(docId);
      const matchCase = options.matchCase ?? entry.matchCase;
      const wholeWord = options.wholeWord ?? entry.wholeWord;
      if (matchCase === entry.matchCase && wholeWord === entry.wholeWord) return;
      patch(docId, (current) => ({ ...current, matchCase, wholeWord }));
      if (isSearchable(entry.text)) run(docId);
    },

    retry: (docId) => run(docId),

    clear: (docId) => reset(docId, {}),

    step: (docId, direction) => {
      const entry = entryOf(docId);
      const count = entry.hits.length;
      if (count === 0) return null;
      const active = entry.active < 0 ? (direction === 1 ? 0 : count - 1) : (entry.active + direction + count) % count;
      patch(docId, (current) => ({ ...current, active, stepped: true }));
      return entry.hits[active] ?? null;
    },

    activate: (docId, index) => {
      const hit = entryOf(docId).hits[index];
      if (hit === undefined) return null;
      patch(docId, (current) => ({ ...current, active: index, stepped: true }));
      return hit;
    },

    requestFocus: () => set((state) => ({ focusRequest: state.focusRequest + 1 })),

    drop: (docId) => {
      stopSearch(docId);
      generations.delete(docId);
      set((state) => {
        if (state.byDoc[docId] === undefined) return state;
        return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
      });
    },
  };
});

/** The search state of `docId` (`NO_SEARCH` for `null` and for a document that has none). */
export function useSearchEntry(docId: number | null): SearchEntry {
  return useSearch((state) => (docId === null ? EMPTY : (state.byDoc[docId] ?? EMPTY)));
}
