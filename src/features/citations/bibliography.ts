import { useEffect } from 'react';
import { create } from 'zustand';

import { toAppError, type AppError } from '../../api/errors';
import { getBibliography, type BibliographyInfo } from '../../api/citations';
import { onChangeSet } from '../../stores/annotations';

/** What is known of one document's record: the answer, a fetch in flight, or the failure. */
interface Entry {
  info?: BibliographyInfo;
  loading: boolean;
  error?: AppError;
}

interface BibState {
  byDoc: Readonly<Record<number, Entry>>;
}

const useBibStore = create<BibState>()(() => ({ byDoc: {} }));

/** The fetches in flight, so that the hook and an export share one request. */
const inflight = new Map<number, Promise<BibliographyInfo>>();

function put(docId: number, entry: Entry | undefined): void {
  useBibStore.setState((state) => {
    const byDoc = { ...state.byDoc };
    if (entry === undefined) delete byDoc[docId];
    else byDoc[docId] = entry;
    return { byDoc };
  });
}

/** Fetches the record once and keeps it; later callers get the cached answer or the request in flight. */
export function fetchBibliography(docId: number): Promise<BibliographyInfo> {
  const cached = useBibStore.getState().byDoc[docId]?.info;
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(docId);
  if (pending !== undefined) return pending;
  put(docId, { loading: true });
  const request = getBibliography(docId).then(
    (info) => {
      // Invalidated or closed while the answer was on its way: that answer may be stale.
      if (inflight.get(docId) === request) put(docId, { info, loading: false });
      return info;
    },
    (caught: unknown) => {
      const error = toAppError(caught);
      if (inflight.get(docId) === request) put(docId, { loading: false, error });
      throw error;
    },
  );
  inflight.set(docId, request);
  const done = () => {
    if (inflight.get(docId) === request) inflight.delete(docId);
  };
  request.then(done, done);
  return request;
}

/** Forgets the record of a document, so that the next look (or a mounted hook) fetches it again. Call it after `setBibliography`. */
export function invalidateBibliography(docId: number): void {
  inflight.delete(docId);
  put(docId, undefined);
}

/** The record, its sources and its pending state, fetched once per document and shared. A failed fetch is `error`; it is retried by `invalidateBibliography`. */
export function useBibliography(docId: number): {
  info: BibliographyInfo | undefined;
  loading: boolean;
  error?: AppError;
} {
  const entry = useBibStore((state) => state.byDoc[docId]);
  const missing = entry === undefined;
  useEffect(() => {
    if (missing) fetchBibliography(docId).catch(() => undefined);
  }, [docId, missing]);
  if (entry === undefined) return { info: undefined, loading: true };
  return entry.error === undefined
    ? { info: entry.info, loading: entry.loading }
    : { info: entry.info, loading: false, error: entry.error };
}

// A command, an undo or a redo that touches the record (`bibliography.set`) and a closed document both drop what is kept.
onChangeSet((docId, changes) => {
  if (changes === null || changes.doc?.includes('bibliography') === true) invalidateBibliography(docId);
});
