import { create } from 'zustand';

import { DEFAULT_ZOOM, clampZoom } from '../lib/zoom';

/**
 * How one open document is shown (ARCHITECTURE section 8, `view`). Fit mode, scroll mode, rotation and the scroll anchor
 * join with M1; today it is the zoom and the page the canvas shows.
 */
export interface DocView {
  /** 1 = 100 %. Always within `MIN_ZOOM..MAX_ZOOM`. */
  zoom: number;
  /** Zero-based position of the page that is shown. Always inside the document. */
  pageIndex: number;
  pageCount: number;
}

/** What the shell shows while no document is open. */
export const NO_VIEW: DocView = { zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: 0 };

export interface ViewState {
  byDoc: Readonly<Record<number, DocView>>;
  /** Registers a document that was just opened: 100 %, first page. */
  open: (docId: number, pageCount: number) => void;
  /** Forgets a closed document. */
  close: (docId: number) => void;
  /** Clamps to the zoom range; ignored for an unknown document. */
  setZoom: (docId: number, zoom: number) => void;
  /** Clamps to the document's pages; ignored for an unknown document. */
  setPage: (docId: number, pageIndex: number) => void;
}

function update(
  state: ViewState,
  docId: number,
  change: (view: DocView) => DocView,
): Pick<ViewState, 'byDoc'> | ViewState {
  const view = state.byDoc[docId];
  if (view === undefined) return state;
  const next = change(view);
  return next.zoom === view.zoom && next.pageIndex === view.pageIndex
    ? state
    : { byDoc: { ...state.byDoc, [docId]: next } };
}

export const useView = create<ViewState>()((set) => ({
  byDoc: {},
  open: (docId, pageCount) =>
    set((state) => ({
      byDoc: {
        ...state.byDoc,
        [docId]: { zoom: DEFAULT_ZOOM, pageIndex: 0, pageCount: Math.max(0, Math.trunc(pageCount)) },
      },
    })),
  close: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
  setZoom: (docId, zoom) => set((state) => update(state, docId, (view) => ({ ...view, zoom: clampZoom(zoom) }))),
  setPage: (docId, pageIndex) =>
    set((state) =>
      update(state, docId, (view) => ({
        ...view,
        pageIndex: Number.isFinite(pageIndex)
          ? Math.min(Math.max(0, view.pageCount - 1), Math.max(0, Math.trunc(pageIndex)))
          : view.pageIndex,
      })),
    ),
}));

/** The view of `docId`, or `NO_VIEW` for `null` and for a document that is not registered. */
export function useDocView(docId: number | null): DocView {
  return useView((state) => (docId === null ? NO_VIEW : (state.byDoc[docId] ?? NO_VIEW)));
}

/**
 * One value out of the view of `docId` (`NO_VIEW` for `null` and for a document that is not registered). The component
 * re-renders only when that value changes: the toolbar asks "is the zoom at its minimum", the zoom readout asks for the zoom
 * and nothing else, so a page change does not wake either. `select` must return a primitive or a part of the stored view.
 */
export function useDocViewValue<T>(docId: number | null, select: (view: DocView) => T): T {
  return useView((state) => select(docId === null ? NO_VIEW : (state.byDoc[docId] ?? NO_VIEW)));
}
