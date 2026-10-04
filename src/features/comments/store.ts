import { create } from 'zustand';

import { listDocumentAnnotations, type AnnotationSummary } from '../../api/annotations';
import { toAppError, type AppError } from '../../api/errors';
import { useDocuments } from '../../stores/documents';
import { NO_FILTER, buildThreads, type Filter, type SortOrder, type Thread } from './model';

/** What the comments of one document are: being fetched (first time), there (maybe being refreshed), or failed. */
export type CommentsEntry =
  | { status: 'loading'; token: number }
  | { status: 'error'; error: AppError; token: number }
  | { status: 'ready'; token: number; summaries: readonly AnnotationSummary[]; threads: readonly Thread[] };

/** The view of one document's list: kept in memory per document, across tab switches. */
export interface CommentsView {
  order: SortOrder;
  filter: Filter;
}

export const DEFAULT_VIEW: CommentsView = { order: 'page', filter: NO_FILTER };

/** The card whose text is being edited. A `fresh` one was just made by Add comment: cancelling it takes it back. */
export interface Editing {
  id: number;
  fresh: boolean;
}

export interface CommentsState {
  byDoc: Readonly<Record<number, CommentsEntry>>;
  views: Readonly<Record<number, CommentsView>>;
  /** Fetches the list; a list that is there stays on screen until the new one arrives. */
  load: (docId: number) => void;
  setOrder: (docId: number, order: SortOrder) => void;
  setFilter: (docId: number, filter: Filter) => void;
  /** The card being edited per document (`null`: none). */
  editing: Readonly<Record<number, Editing | null>>;
  startEdit: (docId: number, id: number, fresh: boolean) => void;
  stopEdit: (docId: number) => void;
  drop: (docId: number) => void;
}

let nextToken = 1;

const sameSummary = (a: AnnotationSummary, b: AnnotationSummary): boolean =>
  a.id === b.id &&
  a.pageId === b.pageId &&
  a.kind === b.kind &&
  a.contents === b.contents &&
  a.author === b.author &&
  a.modified === b.modified &&
  a.inReplyTo === b.inReplyTo &&
  a.state === b.state &&
  a.detail === b.detail &&
  a.color[0] === b.color[0] &&
  a.color[1] === b.color[1] &&
  a.color[2] === b.color[2];

/**
 * The entry for a fresh answer. When nothing in it differs from the list on screen, that list (its summaries and threads, by
 * identity) stays, so a refresh after an edit that does not show here renders no row. Summaries that did not change keep their
 * identity when others did.
 */
export function mergeReady(
  before: CommentsEntry | undefined,
  summaries: readonly AnnotationSummary[],
  token: number,
): Extract<CommentsEntry, { status: 'ready' }> {
  if (before?.status !== 'ready') return { status: 'ready', token, summaries, threads: buildThreads(summaries) };
  const old = new Map(before.summaries.map((summary) => [summary.id, summary]));
  let same = summaries.length === before.summaries.length;
  const merged = summaries.map((summary, index) => {
    const previous = old.get(summary.id);
    if (previous === undefined || !sameSummary(previous, summary)) {
      same = false;
      return summary;
    }
    if (before.summaries[index] !== previous) same = false;
    return previous;
  });
  if (same) return { ...before, token };
  return { status: 'ready', token, summaries: merged, threads: buildThreads(merged) };
}

export const useComments = create<CommentsState>()((set, get) => {
  const patchView = (docId: number, change: (view: CommentsView) => CommentsView) =>
    set((state) => ({ views: { ...state.views, [docId]: change(state.views[docId] ?? DEFAULT_VIEW) } }));

  return {
    byDoc: {},
    views: {},
    editing: {},
    load: (docId) => {
      const token = nextToken++;
      const before = get().byDoc[docId];
      // A list that is on screen is replaced when the new one arrives; the first load (or one after an error) shows the loading state.
      if (before === undefined || before.status === 'error') {
        set((state) => ({ byDoc: { ...state.byDoc, [docId]: { status: 'loading', token } } }));
      } else {
        set((state) => ({ byDoc: { ...state.byDoc, [docId]: { ...before, token } } }));
      }
      listDocumentAnnotations(docId).then(
        (summaries) => {
          // Dropped (closed) or asked again while the answer was on its way.
          if (get().byDoc[docId]?.token !== token) return;
          set((state) => ({
            byDoc: { ...state.byDoc, [docId]: mergeReady(state.byDoc[docId], summaries, token) },
          }));
        },
        (caught: unknown) => {
          if (get().byDoc[docId]?.token !== token) return;
          set((state) => ({
            byDoc: { ...state.byDoc, [docId]: { status: 'error', error: toAppError(caught), token } },
          }));
        },
      );
    },
    setOrder: (docId, order) => patchView(docId, (view) => ({ ...view, order })),
    setFilter: (docId, filter) => patchView(docId, (view) => ({ ...view, filter })),
    startEdit: (docId, id, fresh) => set((state) => ({ editing: { ...state.editing, [docId]: { id, fresh } } })),
    stopEdit: (docId) => set((state) => ({ editing: { ...state.editing, [docId]: null } })),
    drop: (docId) =>
      set((state) => {
        const without = <T>(record: Readonly<Record<number, T>>) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => Number(key) !== docId)) as Record<number, T>;
        return { byDoc: without(state.byDoc), views: without(state.views), editing: without(state.editing) };
      }),
  };
});

// The list goes with its document.
useDocuments.subscribe((state) => {
  const { byDoc, views, drop } = useComments.getState();
  for (const key of new Set([...Object.keys(byDoc), ...Object.keys(views)])) {
    if (state.byId[Number(key)] === undefined) drop(Number(key));
  }
});
