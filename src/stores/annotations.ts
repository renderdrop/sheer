import { create } from 'zustand';

import {
  applyAnnotationCommand,
  listAnnotations,
  redo as redoStep,
  undo as undoStep,
  type Annotation,
  type ChangeSet,
  type DocCommand,
  type HistoryState,
} from '../api/annotations';

/**
 * The UI's replica of each open document's annotations (ARCHITECTURE section 8, `annotations`). The backend owns the model and the
 * undo history; this store only mirrors it. It changes in two ways and no other: a page's annotations are loaded the first time the
 * page is needed (`loadPage`), and every command, undo and redo answers with a change set that is applied (`applyChanges`). Nothing
 * here guesses the outcome of a command, so after a rejected command the replica is exactly what it was.
 *
 * Answers can arrive out of order (they are separate IPC calls): a change set older than the replica's revision is ignored, and a
 * page that was loaded while commands were running never overwrites or resurrects what those commands decided.
 */
export interface DocAnnotations {
  /** The revision of the last change set applied; 0 before any. */
  rev: number;
  /** Every annotation the replica knows, by id. */
  byId: Readonly<Record<number, Annotation>>;
  /** The pages whose annotations were loaded. */
  loaded: Readonly<Record<number, true>>;
  /** Ids a change set removed: a page load that was in flight meanwhile must not bring them back. */
  removed: Readonly<Record<number, true>>;
  history: HistoryState;
}

/** A document without annotations or history. */
export const EMPTY_HISTORY: Readonly<HistoryState> = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  dirty: false,
};

const EMPTY_DOC: Readonly<DocAnnotations> = { rev: 0, byId: {}, loaded: {}, removed: {}, history: EMPTY_HISTORY };

export interface AnnotationsState {
  byDoc: Readonly<Record<number, DocAnnotations>>;

  /**
   * Loads the annotations of a page, once: a page that is loaded or being loaded is not asked for again. Resolves when they are in
   * the store; a failure leaves the page unloaded (a later call tries again) and rejects with the backend's error.
   */
  loadPage: (docId: number, pageId: number) => Promise<void>;
  /** Runs a command on the backend and applies its change set. Rejects with the backend's error, the replica unchanged. */
  apply: (docId: number, command: DocCommand) => Promise<ChangeSet>;
  /** Takes back the last step of the document's history; a no-op for the replica if there is none. */
  undo: (docId: number) => Promise<ChangeSet>;
  redo: (docId: number) => Promise<ChangeSet>;
  /** Applies a change set the backend answered with (`apply`, `undo` and `redo` do it themselves). */
  applyChanges: (docId: number, changes: ChangeSet) => void;
  /** Forgets a closed document. */
  remove: (docId: number) => void;
}

/** The page loads in flight, by document and page, so that two callers share one request. */
const loading = new Map<string, Promise<void>>();

export const useAnnotations = create<AnnotationsState>()((set, get) => ({
  byDoc: {},

  loadPage: (docId, pageId) => {
    if (get().byDoc[docId]?.loaded[pageId] === true) return Promise.resolve();
    const key = `${docId}:${pageId}`;
    const pending = loading.get(key);
    if (pending !== undefined) return pending;
    const request = listAnnotations(docId, pageId)
      .then((annotations) => {
        set((state) => {
          const doc = state.byDoc[docId] ?? EMPTY_DOC;
          const byId = { ...doc.byId };
          // The replica is at least as new as the list: what it has or has dropped stays as it is.
          for (const annotation of annotations) {
            if (byId[annotation.id] === undefined && doc.removed[annotation.id] === undefined) {
              byId[annotation.id] = annotation;
            }
          }
          return { byDoc: { ...state.byDoc, [docId]: { ...doc, byId, loaded: { ...doc.loaded, [pageId]: true } } } };
        });
      })
      .finally(() => {
        loading.delete(key);
      });
    loading.set(key, request);
    return request;
  },

  apply: async (docId, command) => {
    const changes = await applyAnnotationCommand(docId, command);
    get().applyChanges(docId, changes);
    return changes;
  },

  undo: async (docId) => {
    const changes = await undoStep(docId);
    get().applyChanges(docId, changes);
    return changes;
  },

  redo: async (docId) => {
    const changes = await redoStep(docId);
    get().applyChanges(docId, changes);
    return changes;
  },

  applyChanges: (docId, changes) =>
    set((state) => {
      const doc = state.byDoc[docId] ?? EMPTY_DOC;
      // Older than what the replica has (answers crossed): nothing in it is news.
      if (changes.rev < doc.rev) return state;
      // The same objects when nothing changes (an undo with nothing to undo), so the selectors answer the same arrays.
      const changed = changes.removed.length > 0 || changes.upserted.length > 0;
      if (!changed) {
        return { byDoc: { ...state.byDoc, [docId]: { ...doc, rev: changes.rev, history: changes.history } } };
      }
      const byId = { ...doc.byId } as Record<number, Annotation>;
      const removed = { ...doc.removed } as Record<number, true>;
      for (const id of changes.removed) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by annotation id
        delete byId[id];
        removed[id] = true;
      }
      for (const annotation of changes.upserted) {
        byId[annotation.id] = annotation;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by annotation id
        delete removed[annotation.id];
      }
      return {
        byDoc: { ...state.byDoc, [docId]: { ...doc, rev: changes.rev, byId, removed, history: changes.history } },
      };
    }),

  remove: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
}));

/** The history of a document, or the empty one. */
export function historyOf(state: Pick<AnnotationsState, 'byDoc'>, docId: number | null): Readonly<HistoryState> {
  return (docId === null ? undefined : state.byDoc[docId]?.history) ?? EMPTY_HISTORY;
}

const NONE: readonly Annotation[] = [];
const pageCache = new WeakMap<object, Map<number, readonly Annotation[]>>();

/**
 * The annotations of a page in id order. The same array while the document's annotations are unchanged, so a component that selects it does not
 * render again for a selection or a view change.
 */
export function annotationsOnPage(
  state: Pick<AnnotationsState, 'byDoc'>,
  docId: number | null,
  pageId: number,
): readonly Annotation[] {
  const doc = docId === null ? undefined : state.byDoc[docId];
  if (doc === undefined) return NONE;
  let pages = pageCache.get(doc.byId);
  if (pages === undefined) {
    pages = new Map();
    pageCache.set(doc.byId, pages);
  }
  const cached = pages.get(pageId);
  if (cached !== undefined) return cached;
  const list = Object.values(doc.byId)
    .filter((annotation) => annotation.pageId === pageId)
    .sort((a, b) => a.id - b.id);
  pages.set(pageId, list);
  return list;
}

/** Whether a document has changes that are not saved. */
export function isDirty(state: Pick<AnnotationsState, 'byDoc'>, docId: number | null): boolean {
  return historyOf(state, docId).dirty;
}
