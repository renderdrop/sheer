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
  /** Roots whose replies are shown. */
  expanded: ReadonlySet<number>;
}

export const DEFAULT_VIEW: CommentsView = { order: 'page', filter: NO_FILTER, expanded: new Set() };

export interface CommentsState {
  byDoc: Readonly<Record<number, CommentsEntry>>;
  views: Readonly<Record<number, CommentsView>>;
  /** Fetches the list; a list that is there stays on screen until the new one arrives. */
  load: (docId: number) => void;
  setOrder: (docId: number, order: SortOrder) => void;
  setFilter: (docId: number, filter: Filter) => void;
  toggle: (docId: number, root: number) => void;
  expand: (docId: number, root: number) => void;
  drop: (docId: number) => void;
}

let nextToken = 1;

export const useComments = create<CommentsState>()((set, get) => {
  const patchView = (docId: number, change: (view: CommentsView) => CommentsView) =>
    set((state) => ({ views: { ...state.views, [docId]: change(state.views[docId] ?? DEFAULT_VIEW) } }));

  return {
    byDoc: {},
    views: {},
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
            byDoc: {
              ...state.byDoc,
              [docId]: { status: 'ready', token, summaries, threads: buildThreads(summaries) },
            },
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
    toggle: (docId, root) =>
      patchView(docId, (view) => {
        const expanded = new Set(view.expanded);
        if (!expanded.delete(root)) expanded.add(root);
        return { ...view, expanded };
      }),
    expand: (docId, root) =>
      patchView(docId, (view) =>
        view.expanded.has(root) ? view : { ...view, expanded: new Set(view.expanded).add(root) },
      ),
    drop: (docId) =>
      set((state) => {
        const without = <T>(record: Readonly<Record<number, T>>) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => Number(key) !== docId)) as Record<number, T>;
        return { byDoc: without(state.byDoc), views: without(state.views) };
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
