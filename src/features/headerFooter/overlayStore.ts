import { useEffect, useSyncExternalStore } from 'react';

import type { Rgb } from '../../api/annotations';
import { getHeaderFooter, HF_LIMITS, resolveHeaderFooter, type PlacedRun } from '../../api/headerFooter';
import { onChangeSet } from '../../stores/annotations';

/**
 * The pending headers and footers over the pages (ARCHITECTURE 16.2 "Before save", DESIGN 3.15): what the save will write, drawn by
 * the viewer until the save puts the real layer into the file. Runs come from `resolve_header_footer` (spec `null` = the current
 * one), only for pages that ask (mounted ones), in batches of at most 64. A change set that touches the headers and footers (a
 * command, an undo, a redo) or leaves the document clean (a save) makes every page ask again; what was shown stays until the answer.
 */

export interface PageHeaderFooter {
  runs: readonly PlacedRun[];
  color: Rgb;
  /** The spec's background box: drawn behind each run in the page colour, as the save writes it (F21.7). */
  background: boolean;
}

interface PageEntry {
  gen: number;
  /** `null`: nothing to draw (no pending change, or the engine copy still shows the file's layer). */
  value: PageHeaderFooter | null;
}

interface DocState {
  gen: number;
  pages: Map<number, PageEntry>;
  queued: Set<number>;
  scheduled: boolean;
}

const docs = new Map<number, DocState>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stateOf(docId: number): DocState {
  let state = docs.get(docId);
  if (state === undefined) {
    state = { gen: 0, pages: new Map(), queued: new Set(), scheduled: false };
    docs.set(docId, state);
  }
  return state;
}

async function flush(docId: number, state: DocState): Promise<void> {
  state.scheduled = false;
  const wanted = [...state.queued];
  state.queued.clear();
  const gen = state.gen;
  if (wanted.length === 0) return;
  const fresh = (): boolean => docs.get(docId) === state && state.gen === gen;
  try {
    const info = await getHeaderFooter(docId);
    if (!fresh()) return;
    const color = info.spec?.color;
    const background = info.spec?.background === true;
    if (!info.pending || color === undefined) {
      for (const pageId of wanted) state.pages.set(pageId, { gen, value: null });
      notify();
      return;
    }
    for (let i = 0; i < wanted.length; i += HF_LIMITS.resolvePages) {
      const batch = wanted.slice(i, i + HF_LIMITS.resolvePages);
      const resolved = await resolveHeaderFooter(docId, null, batch);
      if (!fresh()) return;
      const answered = new Set<number>();
      for (const page of resolved) {
        answered.add(page.pageId);
        state.pages.set(page.pageId, {
          gen,
          value: page.underFileLayer || page.runs.length === 0 ? null : { runs: page.runs, color, background },
        });
      }
      for (const pageId of batch) if (!answered.has(pageId)) state.pages.set(pageId, { gen, value: null });
      notify();
    }
  } catch {
    // The overlay is a preview: a failed read draws nothing, and the next change asks again.
    if (!fresh()) return;
    for (const pageId of wanted) state.pages.set(pageId, { gen, value: null });
    notify();
  }
}

function request(docId: number, pageId: number): void {
  const state = stateOf(docId);
  if (state.pages.get(pageId)?.gen === state.gen || state.queued.has(pageId)) return;
  state.queued.add(pageId);
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => void flush(docId, state));
}

/** Every page asks again (the answers in view stay until the new ones arrive). */
export function invalidateHeaderFooter(docId: number): void {
  const state = docs.get(docId);
  if (state === undefined) return;
  state.gen += 1;
  state.queued.clear();
  notify();
}

/** Forgets a document (closed). */
export function forgetHeaderFooter(docId: number): void {
  docs.delete(docId);
}

onChangeSet((docId, changes) => {
  if (changes === null) forgetHeaderFooter(docId);
  else if (changes.doc?.includes('headerFooter') === true || !changes.history.dirty) invalidateHeaderFooter(docId);
});

/** The pending header/footer runs of one page (`null`: none to draw); asks for them while `active`. */
export function usePageHeaderFooter(docId: number, pageId: number, active: boolean): PageHeaderFooter | null {
  const gen = useSyncExternalStore(
    subscribe,
    () => docs.get(docId)?.gen ?? 0,
    () => 0,
  );
  const value = useSyncExternalStore(
    subscribe,
    () => docs.get(docId)?.pages.get(pageId)?.value ?? null,
    () => null,
  );
  useEffect(() => {
    if (active) request(docId, pageId);
  }, [active, docId, pageId, gen]);
  return value;
}
