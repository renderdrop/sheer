import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getTextLayer, type TextLayer } from '../../api/text';
import { useDocuments } from '../../stores/documents';

/**
 * The text layers the window has fetched, per document and page. A layer is read once per page (lazily, when the page is on
 * screen) and kept in a small LRU bounded by the amount of text, so a long document cannot make the cache grow without end. The
 * search panel's snippets and the selection's copy read from here too.
 */

/** Most UTF-16 code units kept in all layers together (a box per unit is 16 bytes, so this is about 32 MB). */
export const CACHE_BUDGET_UNITS = 2_000_000;

const layers = new Map<string, TextLayer>();
const inflight = new Map<string, Promise<TextLayer | null>>();
/** Pages whose layer could not be read; asked again only after `clearTextCache`. */
const failed = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
let units = 0;
let watching = false;

const keyOf = (docId: number, page: number) => `${docId}:${page}`;

function notify(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

function drop(key: string): void {
  const layer = layers.get(key);
  if (layer === undefined) return;
  layers.delete(key);
  units -= layer.text.length;
  notify(key);
}

/** Layers of documents that are no longer open are forgotten, as the documents store changes. */
function watchDocuments(): void {
  if (watching) return;
  watching = true;
  useDocuments.subscribe((state) => {
    for (const key of [...layers.keys()]) {
      if (state.byId[Number(key.split(':')[0])] === undefined) drop(key);
    }
  });
}

/** The layer of a page if it has been fetched. Marks it as recently used. */
export function peekLayer(docId: number, page: number): TextLayer | undefined {
  const key = keyOf(docId, page);
  const layer = layers.get(key);
  if (layer !== undefined) {
    layers.delete(key);
    layers.set(key, layer);
  }
  return layer;
}

function remember(key: string, layer: TextLayer): void {
  drop(key);
  layers.set(key, layer);
  units += layer.text.length;
  failed.delete(key);
  notify(key);
  for (const oldest of layers.keys()) {
    if (units <= CACHE_BUDGET_UNITS || oldest === key) break;
    drop(oldest);
  }
}

/** The layer of a page: from the cache, else from Rust (one request per page at a time). `null` when it cannot be read. */
export function loadLayer(docId: number, page: number): Promise<TextLayer | null> {
  const known = peekLayer(docId, page);
  if (known !== undefined) return Promise.resolve(known);
  const key = keyOf(docId, page);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  watchDocuments();
  const request = getTextLayer(docId, page).then(
    (layer) => {
      inflight.delete(key);
      // The document may have been closed meanwhile.
      if (useDocuments.getState().byId[docId] !== undefined) remember(key, layer);
      return layer;
    },
    () => {
      inflight.delete(key);
      failed.add(key);
      notify(key);
      return null;
    },
  );
  inflight.set(key, request);
  return request;
}

/** Forgets everything (tests). */
export function clearTextCache(): void {
  layers.clear();
  inflight.clear();
  failed.clear();
  units = 0;
}

export type PageTextState = { status: 'idle' | 'failed'; layer: null } | { status: 'ready'; layer: TextLayer };

const IDLE: PageTextState = { status: 'idle', layer: null };
const FAILED: PageTextState = { status: 'failed', layer: null };
const readyStates = new WeakMap<TextLayer, PageTextState>();

function stateOf(docId: number, page: number): PageTextState {
  const key = keyOf(docId, page);
  const layer = layers.get(key);
  if (layer === undefined) return failed.has(key) ? FAILED : IDLE;
  let state = readyStates.get(layer);
  if (state === undefined) {
    state = { status: 'ready', layer };
    readyStates.set(layer, state);
  }
  return state;
}

/** The text layer of a page, fetched once `enabled` (the page is on screen). Another page or document starts over. */
export function usePageText(docId: number, page: number, enabled: boolean): PageTextState {
  const subscribe = useCallback(
    (listener: () => void) => {
      const key = keyOf(docId, page);
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
    [docId, page],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => stateOf(docId, page),
    () => IDLE,
  );
  useEffect(() => {
    if (enabled && state.status === 'idle') void loadLayer(docId, page);
  }, [enabled, state.status, docId, page]);
  return state;
}
