import { create } from 'zustand';

import {
  applyCommand,
  listAnnotations,
  redo as redoStep,
  undo as undoStep,
  type Annotation,
  type ChangeSet,
  type DocCommand,
  type HistoryState,
} from '../api/annotations';
import { usePages } from './pages';

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
  /** The selected annotations of each document, in the order they were selected (UI state, not part of the model). */
  selectedIds: Readonly<Record<number, readonly number[]>>;
  /**
   * The revision of each page's pixels, by document and page (the frontend's `pageRev`): it grows when an annotation that is in the file
   * is changed, moved or taken away, or comes back by Undo, because the page image then no longer matches what the overlay draws.
   * Pages not listed are at 0.
   */
  pageRevs: Readonly<Record<number, Readonly<Record<number, number>>>>;

  /**
   * Replaces the selection of a document; an empty list clears it. The same ids in the same order change nothing. A selection lives
   * on one page: ids on another page than the first one's are left out.
   */
  select: (docId: number, ids: readonly number[]) => void;
  /** Empties the selection of a document (nothing changes if it is empty already). */
  clearSelection: (docId: number) => void;
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

/** Whether a page of the document is being loaded: only then does a removed id need to be remembered. */
function loadsRunning(docId: number): boolean {
  const prefix = `${docId}:`;
  for (const key of loading.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

export const useAnnotations = create<AnnotationsState>()((set, get) => ({
  byDoc: {},
  selectedIds: {},
  pageRevs: {},

  select: (docId, requested) =>
    set((state) => {
      const byId = state.byDoc[docId]?.byId;
      const page = requested.length === 0 ? undefined : byId?.[requested[0] as number]?.pageId;
      const ids =
        page === undefined || byId === undefined ? requested : requested.filter((id) => byId[id]?.pageId === page);
      const current = state.selectedIds[docId] ?? [];
      if (current.length === ids.length && current.every((id, i) => id === ids[i])) return state;
      return { selectedIds: { ...state.selectedIds, [docId]: ids } };
    }),

  clearSelection: (docId) => get().select(docId, []),

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
        // Nothing can bring a removed id back any more: forget them (the list would only grow).
        if (loadsRunning(docId)) return;
        set((state) => {
          const doc = state.byDoc[docId];
          if (doc === undefined || Object.keys(doc.removed).length === 0) return state;
          return { byDoc: { ...state.byDoc, [docId]: { ...doc, removed: {} } } };
        });
      });
    loading.set(key, request);
    return request;
  },

  apply: async (docId, command) => {
    const changes = await applyCommand(docId, command);
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

  applyChanges: (docId, changes) => {
    if (changes.pages !== null && changes.rev >= (get().byDoc[docId]?.rev ?? 0))
      usePages.getState().setSlots(docId, changes.pages);
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
      const remember = loadsRunning(docId);
      for (const id of changes.removed) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by annotation id
        delete byId[id];
        if (remember) removed[id] = true;
      }
      for (const annotation of changes.upserted) {
        byId[annotation.id] = annotation;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by annotation id
        delete removed[annotation.id];
      }
      // A page whose bitmap shows an annotation that changed (or no longer exists) needs a new image.
      const stale = new Set<number>();
      for (const id of changes.removed) {
        const before = doc.byId[id];
        if (before !== undefined && before.sync !== 'new') stale.add(before.pageId);
      }
      for (const annotation of changes.upserted) {
        const before = doc.byId[annotation.id];
        if (annotation.sync !== 'new' || (before !== undefined && before.sync !== 'new')) {
          stale.add(annotation.pageId);
          if (before !== undefined) stale.add(before.pageId);
        }
      }
      let pageRevs = state.pageRevs;
      if (stale.size > 0) {
        const revs = { ...(pageRevs[docId] ?? {}) } as Record<number, number>;
        for (const page of stale) revs[page] = (revs[page] ?? 0) + 1;
        pageRevs = { ...pageRevs, [docId]: revs };
      }
      // What was removed cannot stay selected.
      const selected = state.selectedIds[docId];
      const kept = selected?.filter((id) => byId[id] !== undefined);
      return {
        byDoc: { ...state.byDoc, [docId]: { ...doc, rev: changes.rev, byId, removed, history: changes.history } },
        ...(pageRevs !== state.pageRevs ? { pageRevs } : {}),
        ...(selected !== undefined && kept !== undefined && kept.length !== selected.length
          ? { selectedIds: { ...state.selectedIds, [docId]: kept } }
          : {}),
      };
    });
  },

  remove: (docId) =>
    set((state) => {
      for (const key of [...lastByPage.keys()]) if (key.startsWith(`${docId}:`)) lastByPage.delete(key);
      if (state.byDoc[docId] === undefined) return state;
      return {
        byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)),
        selectedIds: Object.fromEntries(Object.entries(state.selectedIds).filter(([id]) => Number(id) !== docId)),
        pageRevs: Object.fromEntries(Object.entries(state.pageRevs).filter(([id]) => Number(id) !== docId)),
      };
    }),
}));

/** The revision of a page's pixels; 0 until an annotation that is in the file changes. */
export function pageRevOf(state: Pick<AnnotationsState, 'pageRevs'>, docId: number, pageId: number): number {
  return state.pageRevs[docId]?.[pageId] ?? 0;
}

/** The history of a document, or the empty one. */
export function historyOf(state: Pick<AnnotationsState, 'byDoc'>, docId: number | null): Readonly<HistoryState> {
  return (docId === null ? undefined : state.byDoc[docId]?.history) ?? EMPTY_HISTORY;
}

const NONE: readonly Annotation[] = [];
const pageCache = new WeakMap<object, Map<number, readonly Annotation[]>>();
/** The last list of each page, by `doc:page`: a change to one page hands the other pages the arrays they had. */
const lastByPage = new Map<string, readonly Annotation[]>();

/**
 * The annotations of a page in id order. The same array while the page's annotations are unchanged (also when another page's change
 * made a new `byId`), so a component that selects it does not render again for a selection, a view change or an edit elsewhere.
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
  const fresh = Object.values(doc.byId)
    .filter((annotation) => annotation.pageId === pageId)
    .sort((a, b) => a.id - b.id);
  // The same annotations in the same order are the same array, so the page's layer does not render for a change elsewhere.
  const key = `${docId}:${pageId}`;
  const before = lastByPage.get(key);
  const list =
    before !== undefined && before.length === fresh.length && before.every((annotation, i) => annotation === fresh[i])
      ? before
      : fresh;
  lastByPage.set(key, list);
  pages.set(pageId, list);
  return list;
}

/** Whether a document has changes that are not saved. */
export function isDirty(state: Pick<AnnotationsState, 'byDoc'>, docId: number | null): boolean {
  return historyOf(state, docId).dirty;
}
