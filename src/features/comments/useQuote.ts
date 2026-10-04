import { useEffect, useState } from 'react';

import { getAnnotationQuote } from '../../api/annotations';

/** Quotes kept (a quote is at most 280 characters): the oldest goes first. */
const MAX_CACHED = 1000;
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** Forgets every quote (a test, or a document that was closed and whose ids are not reused anyway). */
export function clearQuotes(): void {
  cache.clear();
  pending.clear();
}

/** The quote of a text markup, fetched once and kept: `undefined` while it is on its way, `null` when there is none. */
export function useQuote(docId: number, id: number, enabled: boolean): string | null | undefined {
  const key = `${docId}:${id}`;
  const [quote, setQuote] = useState<string | null | undefined>(() => (enabled ? cache.get(key) : null));
  useEffect(() => {
    if (!enabled || cache.has(key)) return;
    let live = true;
    let request = pending.get(key);
    if (request === undefined) {
      request = getAnnotationQuote(docId, id).catch(() => null);
      pending.set(key, request);
    }
    void request.then((text) => {
      pending.delete(key);
      cache.set(key, text);
      if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      if (live) setQuote(text);
    });
    return () => {
      live = false;
    };
  }, [docId, id, enabled, key]);
  if (!enabled) return null;
  return cache.has(key) ? cache.get(key) : quote;
}
