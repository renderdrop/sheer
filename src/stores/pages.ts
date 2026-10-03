import { create } from 'zustand';

import type { PageSize } from '../api/render';

/**
 * The size of every page of each open document in PDF points (ARCHITECTURE section 8, the `documents` store's page list; a store of
 * its own until pages can be reordered). It is what the canvas lays itself out from, so every page has a placeholder of the right
 * size before its first pixel is rendered. The backend reports it with `get_page_sizes`; each document's list is replaced as a
 * whole and never edited.
 */
export interface PagesState {
  byDoc: Readonly<Record<number, readonly PageSize[]>>;
  /** Stores the sizes of a document that was just opened (or reloaded). */
  set: (docId: number, sizes: readonly PageSize[]) => void;
  /** Forgets a closed document. */
  remove: (docId: number) => void;
}

export const usePages = create<PagesState>()((set) => ({
  byDoc: {},
  set: (docId, sizes) => set((state) => ({ byDoc: { ...state.byDoc, [docId]: sizes } })),
  remove: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
}));

/** What a page is taken to be until its size is known: US Letter, the backend's own fallback (`DEFAULT_PAGE_SIZE_PT`). */
export const DEFAULT_PAGE_SIZE: PageSize = [612, 792];

const placeholders = new Map<number, readonly PageSize[]>();

/**
 * `count` pages of the default size. The same list for the same count, so a layout built from it stays valid: the canvas of a
 * document whose sizes have not arrived yet does not lay itself out afresh on every render.
 */
export function placeholderSizes(count: number): readonly PageSize[] {
  const pages = Math.max(0, Math.trunc(count));
  let sizes = placeholders.get(pages);
  if (sizes === undefined) {
    sizes = Array.from({ length: pages }, () => DEFAULT_PAGE_SIZE);
    // A few document lengths at a time are enough; the list is dropped when it is not the one that is in use.
    if (placeholders.size >= 4) placeholders.clear();
    placeholders.set(pages, sizes);
  }
  return sizes;
}

/**
 * The sizes to lay a document out from: the ones the backend reported if they cover the document's pages, else placeholders.
 * A list of the wrong length (the document changed under it) is not trusted.
 */
export function sizesFor(
  state: Pick<PagesState, 'byDoc'>,
  docId: number | null,
  pageCount: number,
): readonly PageSize[] {
  const known = docId === null ? undefined : state.byDoc[docId];
  return known !== undefined && known.length === pageCount ? known : placeholderSizes(pageCount);
}
