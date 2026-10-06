import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getSmartLinks, type SmartLink } from '../../api/smartLinks';
import { useDocuments } from '../../stores/documents';
import { useSmartLinks } from './store';

/**
 * The smart links the window has fetched, per document and page (DESIGN 3.11 L10). A page is asked for lazily, when it is in the
 * render window, at idle priority; the answer is kept for the `stamp` it was asked for (the document's change counters: any change
 * to the page, an undo, a text edit gives a new stamp) and for the revision Rust answered. An answer of an older stamp is never
 * returned, and when a newer revision arrives the entries of older revisions of that document are dropped. Off is simply not asking.
 */

interface Entry {
  stamp: string;
  rev: number;
  links: readonly SmartLink[];
}

/** Most pages kept; the oldest go first. */
export const MAX_ENTRIES = 200;
/** An index that is not ready is asked again this often, this many times. */
export const READY_RETRY_MS = 600;
export const READY_RETRIES = 20;
/** The longest a request waits for an idle moment. */
export const IDLE_TIMEOUT_MS = 500;

const entries = new Map<string, Entry>();
const inflight = new Map<string, string>();
const wanted = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const latestRev = new Map<number, number>();
let watching = false;

const keyOf = (docId: number, page: number) => `${docId}:${page}`;
const docOf = (key: string) => Number(key.split(':')[0]);

function notify(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

function drop(key: string): void {
  if (entries.delete(key)) notify(key);
}

function watchDocuments(): void {
  if (watching) return;
  watching = true;
  useDocuments.subscribe((state) => {
    for (const key of [...entries.keys()]) if (state.byId[docOf(key)] === undefined) drop(key);
    for (const key of [...latestRev.keys()]) {
      if (state.byId[key] === undefined) {
        latestRev.delete(key);
        useSmartLinks.getState().forget(key);
      }
    }
  });
}

function remember(key: string, entry: Entry): void {
  const doc = docOf(key);
  const known = latestRev.get(doc) ?? -1;
  if (entry.rev > known) {
    latestRev.set(doc, entry.rev);
    // A newer revision: what was detected for an older one is stale.
    for (const [other, old] of [...entries]) if (docOf(other) === doc && old.rev < entry.rev) drop(other);
  }
  entries.delete(key);
  entries.set(key, entry);
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    drop(oldest);
  }
  notify(key);
}

type Idle = (run: () => void) => void;
const whenIdle: Idle = (run) => {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(run, 0);
};

/** Asks Rust for the links of a page, once at a time per page, again while its index is not ready and someone still wants them. */
function request(docId: number, page: number, stamp: string, attempt = 0): void {
  const key = keyOf(docId, page);
  if (inflight.get(key) === stamp) return;
  inflight.set(key, stamp);
  whenIdle(() => {
    if ((wanted.get(key) ?? 0) === 0 || useDocuments.getState().byId[docId] === undefined) {
      if (inflight.get(key) === stamp) inflight.delete(key);
      return;
    }
    getSmartLinks(docId, page).then(
      (result) => {
        // A newer stamp was asked for meanwhile: this answer is for a page that no longer is.
        if (inflight.get(key) !== stamp) return;
        inflight.delete(key);
        if (useDocuments.getState().byId[docId] === undefined) return;
        if (!result.ready) {
          if (attempt < READY_RETRIES) {
            setTimeout(() => {
              if ((wanted.get(key) ?? 0) > 0) request(docId, page, stamp, attempt + 1);
            }, READY_RETRY_MS);
          }
          return;
        }
        remember(key, { stamp, rev: result.rev, links: result.links });
      },
      () => {
        // A page the backend cannot answer has no links; it is not asked again for this stamp.
        if (inflight.get(key) !== stamp) return;
        inflight.delete(key);
        remember(key, { stamp, rev: latestRev.get(docId) ?? 0, links: [] });
      },
    );
  });
}

/**
 * The smart links of a page for `stamp`, or `null` while there are none to show (not asked yet, on their way, stale). Asks for them
 * when `active` (the page is in the render window and links are on); with `active` false nothing is asked and nothing is returned.
 */
export function usePageSmartLinks(
  docId: number,
  page: number,
  stamp: string,
  active: boolean,
): readonly SmartLink[] | null {
  const subscribe = useCallback(
    (listener: () => void) => {
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
  const entry = useSyncExternalStore(
    subscribe,
    () => entries.get(keyOf(docId, page)),
    () => undefined,
  );
  const fresh = entry !== undefined && entry.stamp === stamp;
  useEffect(() => {
    if (!active) return;
    const key = keyOf(docId, page);
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
    if (!fresh) request(docId, page, stamp);
    return () => {
      const left = (wanted.get(key) ?? 1) - 1;
      if (left <= 0) wanted.delete(key);
      else wanted.set(key, left);
    };
  }, [active, docId, page, stamp, fresh]);
  return active && fresh ? entry.links : null;
}

/** Forgets everything (tests). */
export function clearSmartLinkCache(): void {
  entries.clear();
  inflight.clear();
  wanted.clear();
  listeners.clear();
  latestRev.clear();
}
