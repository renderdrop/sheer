import { create } from 'zustand';

import {
  listContentObjects,
  type ChangeSet,
  type ContentAnnotation,
  type Rgb,
  type StdFont,
} from '../../api/annotations';
import type { ImageAssetInfo } from '../../api/content';
import type { Rect } from '../../api/wire';
import { forgetAssets } from './assets';

/**
 * The UI's replica of the text boxes and images of each open document (DESIGN 3.36, ADR-047). The backend sends them in
 * `ChangeSet.content`, apart from the comments, so they never reach the comments list. `applyContentChanges` is called by
 * the annotation store for every change set (a command, an undo, a redo); a page's objects are read once when it is shown.
 * Nothing here guesses the outcome of a command.
 */
export type ContentObject = Extract<ContentAnnotation, { kind: 'textBox' | 'image' }>;
export type TextBoxObject = Extract<ContentObject, { kind: 'textBox' }>;
export type ImageObject = Extract<ContentObject, { kind: 'image' }>;

export const isContentObject = (object: ContentAnnotation): object is ContentObject =>
  object.kind === 'textBox' || object.kind === 'image';

interface DocContent {
  rev: number;
  byId: Readonly<Record<number, ContentObject>>;
  loaded: Readonly<Record<number, true>>;
  /** Ids a change set removed: a page read that was in flight must not bring them back. */
  gone: Readonly<Record<number, true>>;
}

/** The text being edited: an existing text box, or a new one (`id` null) that exists only once it has text. */
export interface Editing {
  docId: number;
  pageId: number;
  id: number | null;
  box: Rect;
}

/** The style a new text box gets (the tool options). */
export interface InsertStyle {
  font: StdFont;
  fontSize: number;
  color: Rgb;
}

export const DEFAULT_INSERT_STYLE: InsertStyle = { font: 'sans', fontSize: 12, color: [0, 0, 0] };

export interface InsertState {
  byDoc: Readonly<Record<number, DocContent>>;
  /** The selected object of each document (one at a time). */
  selected: Readonly<Record<number, number | null>>;
  /** Further objects Shift-click added to the selection of each document (DESIGN 3.23). */
  extra: Readonly<Record<number, readonly number[]>>;
  editing: Editing | null;
  /** The image the Add image tool has chosen and that the next click places. */
  pendingImage: ImageAssetInfo | null;
  /** The image dialog is open. */
  arming: boolean;
  /** Corners keep the aspect of an image; Shift flips it while dragging (DESIGN 3.36). */
  lockAspect: boolean;
  style: InsertStyle;

  select: (docId: number, id: number | null) => void;
  /** Shift-click: adds the object to the selection or takes it out. */
  toggle: (docId: number, id: number) => void;
  startEditing: (editing: Editing) => void;
  stopEditing: () => void;
  setPendingImage: (image: ImageAssetInfo | null) => void;
  setArming: (arming: boolean) => void;
  setLockAspect: (lock: boolean) => void;
  setStyle: (change: Partial<InsertStyle>) => void;
  loadPage: (docId: number, pageId: number) => Promise<void>;
  applyContentChanges: (docId: number, changes: ChangeSet) => void;
  remove: (docId: number) => void;
}

const loading = new Map<string, Promise<void>>();

const EMPTY_DOC: DocContent = { rev: 0, byId: {}, loaded: {}, gone: {} };

export const useInsert = create<InsertState>()((set, get) => ({
  byDoc: {},
  selected: {},
  extra: {},
  editing: null,
  pendingImage: null,
  arming: false,
  lockAspect: true,
  style: DEFAULT_INSERT_STYLE,

  select: (docId, id) =>
    set((state) => {
      const same = (state.selected[docId] ?? null) === id;
      if (same && (state.extra[docId]?.length ?? 0) === 0) return state;
      return { selected: { ...state.selected, [docId]: id }, extra: { ...state.extra, [docId]: [] } };
    }),
  toggle: (docId, id) =>
    set((state) => {
      const ids = selectionIds(state, docId);
      const next = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
      return {
        selected: { ...state.selected, [docId]: next[0] ?? null },
        extra: { ...state.extra, [docId]: next.slice(1) },
      };
    }),
  startEditing: (editing) => set({ editing }),
  stopEditing: () => set((state) => (state.editing === null ? state : { editing: null })),
  setPendingImage: (pendingImage) => set({ pendingImage }),
  setArming: (arming) => set({ arming }),
  setLockAspect: (lockAspect) => set({ lockAspect }),
  setStyle: (change) => set((state) => ({ style: { ...state.style, ...change } })),

  loadPage: (docId, pageId) => {
    if (get().byDoc[docId]?.loaded[pageId] === true) return Promise.resolve();
    const k = `${docId}:${pageId}`;
    const pending = loading.get(k);
    if (pending !== undefined) return pending;
    const request = listContentObjects(docId, pageId)
      .then((list) => {
        set((state) => {
          const doc = state.byDoc[docId] ?? EMPTY_DOC;
          const byId = { ...doc.byId } as Record<number, ContentObject>;
          for (const object of list) {
            if (isContentObject(object) && byId[object.id] === undefined && doc.gone[object.id] === undefined) {
              byId[object.id] = object;
            }
          }
          return { byDoc: { ...state.byDoc, [docId]: { ...doc, byId, loaded: { ...doc.loaded, [pageId]: true } } } };
        });
      })
      .finally(() => loading.delete(k));
    loading.set(k, request);
    return request;
  },

  applyContentChanges: (docId, changes) => {
    const content = (changes.content ?? []).filter(isContentObject);
    const before = get().byDoc[docId];
    const anyRemoved = changes.removed.length > 0;
    if (content.length === 0 && !anyRemoved) {
      // Nothing of ours changed; only the revision moves, so a late older answer is still recognised as late.
      if (before !== undefined && changes.rev > before.rev) {
        set((state) => ({ byDoc: { ...state.byDoc, [docId]: { ...before, rev: changes.rev } } }));
      }
      return;
    }
    set((state) => {
      const doc = state.byDoc[docId] ?? EMPTY_DOC;
      // Older than what the replica has (answers crossed): nothing in it is news.
      if (changes.rev < doc.rev) return state;
      const byId = { ...doc.byId } as Record<number, ContentObject>;
      const gone = { ...doc.gone } as Record<number, true>;
      for (const id of changes.removed) {
        delete byId[id];
        gone[id] = true;
      }
      for (const object of content) {
        byId[object.id] = object;

        delete gone[object.id];
      }
      const before = selectionIds(state, docId);
      const kept = before.filter((id) => byId[id] !== undefined);
      const editingGone = state.editing !== null && state.editing.id !== null && byId[state.editing.id] === undefined;
      return {
        byDoc: { ...state.byDoc, [docId]: { ...doc, rev: changes.rev, byId, gone } },
        ...(kept.length !== before.length
          ? {
              selected: { ...state.selected, [docId]: kept[0] ?? null },
              extra: { ...state.extra, [docId]: kept.slice(1) },
            }
          : {}),
        ...(editingGone ? { editing: null } : {}),
      };
    });
  },

  remove: (docId) => {
    forgetAssets(docId);
    set((state) => {
      if (state.byDoc[docId] === undefined && state.selected[docId] === undefined) return state;
      return {
        byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)),
        selected: Object.fromEntries(Object.entries(state.selected).filter(([id]) => Number(id) !== docId)),
        extra: Object.fromEntries(Object.entries(state.extra).filter(([id]) => Number(id) !== docId)),
        ...(state.editing?.docId === docId ? { editing: null } : {}),
      };
    });
  },
}));

/** All selected ids of a document, the primary first. */
export function selectionIds(state: Pick<InsertState, 'selected' | 'extra'>, docId: number): readonly number[] {
  const primary = state.selected[docId] ?? null;
  return primary === null ? [] : [primary, ...(state.extra[docId] ?? [])];
}

const NONE: readonly ContentObject[] = [];
const pageCache = new WeakMap<object, Map<number, readonly ContentObject[]>>();

/** The text boxes and images of a page in id order; the same array while they are unchanged. */
export function objectsOnPage(
  state: Pick<InsertState, 'byDoc'>,
  docId: number | null,
  pageId: number,
): readonly ContentObject[] {
  const doc = docId === null ? undefined : state.byDoc[docId];
  if (doc === undefined) return NONE;
  let pages = pageCache.get(doc.byId);
  if (pages === undefined) {
    pages = new Map();
    pageCache.set(doc.byId, pages);
  }
  let list = pages.get(pageId);
  if (list === undefined) {
    list = Object.values(doc.byId)
      .filter((object) => object.pageId === pageId)
      .sort((a, b) => a.id - b.id);
    pages.set(pageId, list);
  }
  return list;
}

/** Forgets a closed document's objects (called by the annotation store's `remove`). */
export function removeContent(docId: number): void {
  useInsert.getState().remove(docId);
}

/** Applies the content part of a change set (called by the annotation store). */
export function applyContentChanges(docId: number, changes: ChangeSet): void {
  useInsert.getState().applyContentChanges(docId, changes);
}
