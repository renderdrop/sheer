import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getTextLayer, type TextLayer } from '../../api/text';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { forgetFileRotations, setFileRotation } from '../viewer/fileRotation';

/**
 * The text layers the window has fetched, per document and page. A layer is read once per page (lazily, when the page is on
 * screen) and kept in a small LRU bounded by the amount of text, so a long document cannot make the cache grow without end. The
 * search panel's snippets and the selection's copy read from here too.
 */

/** Most UTF-16 code units kept in all layers together (a box per unit is 16 bytes, so this is about 32 MB). */
export const CACHE_BUDGET_UNITS = 2_000_000;

const layers = new Map<string, TextLayer>();
const inflight = new Map<string, Promise<TextLayer | null>>();
/** Pages whose layer could not be read; asked again only after `clearTextCache`, or once the oldest of them is forgotten. */
const failed = new Set<string>();
/** Most failed pages remembered; a hostile document with thousands of unreadable pages cannot make the set grow without end. */
export const MAX_FAILED_PAGES = 1024;
const listeners = new Map<string, Set<() => void>>();
/** The documents whose pages' rotations were recorded here. */
const knownDocs = new Set<number>();
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
    const closed = (key: string) => state.byId[Number(key.split(':')[0])] === undefined;
    for (const key of [...layers.keys()]) if (closed(key)) drop(key);
    // What is kept about the pages of a closed document goes too: failures, listeners that were never removed, rotations.
    for (const key of [...failed]) if (closed(key)) failed.delete(key);
    for (const key of [...listeners.keys()]) if (closed(key)) listeners.delete(key);
    for (const docId of knownDocs) {
      if (state.byId[docId] === undefined) {
        forgetFileRotations(docId);
        knownDocs.delete(docId);
      }
    }
  });
  // A page whose revision changed (a crop, its undo, a rotation) has other page-space boxes: its layer is read again.
  usePages.subscribe((state, previous) => {
    for (const [key, slots] of Object.entries(state.slotsByDoc)) {
      const docId = Number(key);
      const before = new Map((previous.slotsByDoc[docId] ?? []).map((slot) => [slot.id, slot.rev]));
      for (const slot of slots) {
        const old = before.get(slot.id);
        if (old === undefined || old === slot.rev) continue;
        const pageKey = keyOf(docId, slot.id);
        inflight.delete(pageKey);
        failed.delete(pageKey);
        drop(pageKey);
      }
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

function remember(key: string, layer: TextLayer, docId: number, page: number): void {
  // The rotation outlives the layer in the cache: it is a few bytes, and the overlays need it after the text was evicted.
  setFileRotation(docId, page, layer.rotation ?? 0);
  knownDocs.add(docId);
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
      if (useDocuments.getState().byId[docId] !== undefined) remember(key, layer, docId, page);
      return layer;
    },
    () => {
      inflight.delete(key);
      failed.add(key);
      for (const oldest of failed) {
        if (failed.size <= MAX_FAILED_PAGES) break;
        failed.delete(oldest);
      }
      notify(key);
      return null;
    },
  );
  inflight.set(key, request);
  return request;
}

/**
 * Forgets the text of every page of a document (its layers, failures and requests in flight), so the next read asks Rust again: the
 * text changed under the cache (a recognized layer was applied or taken back). Pages on screen are told and read again.
 */
export function dropDocumentText(docId: number): void {
  const mine = (key: string) => key.startsWith(`${docId}:`);
  inflight.forEach((_, key) => {
    if (mine(key)) inflight.delete(key);
  });
  for (const key of [...failed]) if (mine(key)) failed.delete(key);
  const keys = new Set([...layers.keys(), ...listeners.keys()].filter(mine));
  for (const key of keys) {
    drop(key);
    notify(key);
  }
}

/** Forgets everything (tests). */
export function clearTextCache(): void {
  layers.clear();
  inflight.clear();
  failed.clear();
  listeners.clear();
  for (const docId of knownDocs) forgetFileRotations(docId);
  knownDocs.clear();
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
      // The clean-up of closed documents is armed by the first subscriber, not only by the first fetch: a page that subscribed and whose
      // document was closed before anything was fetched leaves nothing behind.
      watchDocuments();
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
