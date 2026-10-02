import { create } from 'zustand';

import type { DocumentInfo } from '../api/documents';

/**
 * The open documents (ARCHITECTURE section 8, `documents`), keyed by the id the backend gave them. The backend's registry is
 * the authority: a document is here because the backend opened it (the dialog, a drop, the OS), reported it as `opened`, and
 * is gone when it is closed. The frontend never holds a path, only the id and what the backend lets it show.
 *
 * How a document is shown (zoom, page) is the `view` store's business and the page image the viewer's; this store only knows
 * which documents are open, in what order, and which one is active.
 */
export interface DocumentsState {
  byId: Readonly<Record<number, DocumentInfo>>;
  /** Ids in the order the documents were opened (the order of their tabs, once there are tabs). */
  order: readonly number[];
  /** The document the canvas shows, `null` while none is open. */
  activeId: number | null;

  /**
   * Adds a document the backend opened and makes it the active one. An id that is known already (the backend answers a file
   * that is open again with the id it has) keeps its place in the order, takes the new info and becomes active.
   */
  add: (info: DocumentInfo) => void;
  /** Forgets a closed document. If it was the active one, the next in the order becomes active, else the one before it. */
  remove: (id: number) => void;
  /** Makes an open document the active one; ignored for an unknown id. */
  setActive: (id: number) => void;
}

export const useDocuments = create<DocumentsState>()((set) => ({
  byId: {},
  order: [],
  activeId: null,

  add: (info) =>
    set((state) => ({
      byId: { ...state.byId, [info.id]: info },
      order: state.order.includes(info.id) ? state.order : [...state.order, info.id],
      activeId: info.id,
    })),

  remove: (id) =>
    set((state) => {
      if (state.byId[id] === undefined) return state;
      const index = state.order.indexOf(id);
      const order = state.order.filter((open) => open !== id);
      const byId = Object.fromEntries(Object.entries(state.byId).filter(([key]) => Number(key) !== id));
      const activeId = state.activeId === id ? (order[index] ?? order[index - 1] ?? null) : state.activeId;
      return { byId, order, activeId };
    }),

  setActive: (id) => set((state) => (state.byId[id] === undefined || state.activeId === id ? state : { activeId: id })),
}));

/** The id of the active document, or `null`. A selector, so a component re-renders when the active document changes and not before. */
export const selectActiveId = (state: DocumentsState): number | null => state.activeId;

/** The active document's info, or `null`. */
export const selectActiveDocument = (state: DocumentsState): DocumentInfo | null =>
  state.activeId === null ? null : (state.byId[state.activeId] ?? null);
