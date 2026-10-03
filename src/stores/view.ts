import { create } from 'zustand';

import { DEFAULT_SCROLL_MODE, type ScrollAnchor, type ScrollMode } from '../features/viewer/layout';
import { normalizeRotation, type Rotation } from '../features/viewer/transform';
import { DEFAULT_ZOOM, clampZoom } from '../lib/zoom';

/**
 * What stays fitted as the window changes: `width` fills the canvas's width, `page` shows the whole page, `none` is a zoom the
 * user chose. A fit is a mode, not a one-time zoom: it follows a resize of the window (the viewer recomputes the zoom) until the
 * user zooms by hand.
 */
export type FitMode = 'none' | 'width' | 'page';

/** How one open document is shown (ARCHITECTURE section 8, `view`). */
export interface DocView {
  /** 1 = 100 %. Always within `MIN_ZOOM..MAX_ZOOM`. */
  zoom: number;
  fit: FitMode;
  scrollMode: ScrollMode;
  /** The view rotation in degrees, clockwise (DESIGN 3.20): for viewing only, per document, in memory. */
  rotation: Rotation;
  /**
   * Zero-based position of the current page, always inside the document. In continuous mode it follows the scroll position (the
   * page most of the viewport is on); in the paged modes it is the page that is shown (the first of a spread).
   */
  pageIndex: number;
  pageCount: number;
  /**
   * Where the canvas is to put the document next time it lays itself out: set by a zoom, a change of mode and a jump to a page,
   * and cleared by the canvas once it has scrolled there (`consumeAnchor`). Never read by anything else.
   */
  anchor: ScrollAnchor | null;
  /** True from the opening of a document until its opening zoom is known: the readouts show no zoom meanwhile. */
  opening: boolean;
}

/** What the shell shows while no document is open. */
export const NO_VIEW: DocView = {
  zoom: DEFAULT_ZOOM,
  fit: 'none',
  scrollMode: DEFAULT_SCROLL_MODE,
  rotation: 0,
  pageIndex: 0,
  pageCount: 0,
  anchor: null,
  opening: false,
};

export interface ViewState {
  byDoc: Readonly<Record<number, DocView>>;
  /** Registers a document that was just opened: 100 %, continuous scrolling, first page. */
  open: (docId: number, pageCount: number, opening?: boolean) => void;
  /** The opening zoom of the document is committed: the readouts may show it. */
  settleOpening: (docId: number) => void;
  /** Forgets a closed document. */
  close: (docId: number) => void;
  /**
   * A zoom the user chose: clamped to the zoom range, it ends a fit. `anchor` is the document point the canvas keeps where it is
   * (the pointer for a wheel or pinch, the middle of the viewport otherwise). Ignored for an unknown document.
   */
  setZoom: (docId: number, zoom: number, anchor?: ScrollAnchor | null) => void;
  /** Zooms to `zoom` as a fit of the page's width or of the whole page: the mode stays until the next `setZoom`. */
  setFit: (docId: number, fit: 'width' | 'page', zoom: number, anchor?: ScrollAnchor | null) => void;
  /** Goes to a page (clamped to the document's pages). `anchor` puts it at the top of the viewport. */
  setPage: (docId: number, pageIndex: number, anchor?: ScrollAnchor | null) => void;
  /** The canvas says which page the scroll position is on. Not a request to scroll. */
  reportPage: (docId: number, pageIndex: number) => void;
  /** Changes how pages are laid out. `zoom` is the new zoom of a fit that has to be made again for the new mode. */
  setScrollMode: (docId: number, mode: ScrollMode, anchor?: ScrollAnchor | null, zoom?: number) => void;
  /** Turns the view to `rotation` (normalized to a quarter turn). `zoom` is the new zoom of a fit that has to be made again. */
  setRotation: (docId: number, rotation: number, anchor?: ScrollAnchor | null, zoom?: number) => void;
  /** The canvas has scrolled to the anchor. */
  consumeAnchor: (docId: number) => void;
}

function sameView(a: DocView, b: DocView): boolean {
  return (
    a.zoom === b.zoom &&
    a.fit === b.fit &&
    a.scrollMode === b.scrollMode &&
    a.rotation === b.rotation &&
    a.pageIndex === b.pageIndex &&
    a.pageCount === b.pageCount &&
    a.anchor === b.anchor &&
    a.opening === b.opening
  );
}

function update(
  state: ViewState,
  docId: number,
  change: (view: DocView) => DocView,
): Pick<ViewState, 'byDoc'> | ViewState {
  const view = state.byDoc[docId];
  if (view === undefined) return state;
  const next = change(view);
  return sameView(next, view) ? state : { byDoc: { ...state.byDoc, [docId]: next } };
}

function clampPage(view: DocView, pageIndex: number): number {
  return Number.isFinite(pageIndex)
    ? Math.min(Math.max(0, view.pageCount - 1), Math.max(0, Math.trunc(pageIndex)))
    : view.pageIndex;
}

export const useView = create<ViewState>()((set) => ({
  byDoc: {},
  open: (docId, pageCount, opening = false) =>
    set((state) => ({
      byDoc: { ...state.byDoc, [docId]: { ...NO_VIEW, pageCount: Math.max(0, Math.trunc(pageCount)), opening } },
    })),
  settleOpening: (docId) => set((state) => update(state, docId, (view) => ({ ...view, opening: false }))),
  close: (docId) =>
    set((state) => {
      if (state.byDoc[docId] === undefined) return state;
      return { byDoc: Object.fromEntries(Object.entries(state.byDoc).filter(([id]) => Number(id) !== docId)) };
    }),
  setZoom: (docId, zoom, anchor = null) =>
    set((state) =>
      update(state, docId, (view) => ({ ...view, zoom: clampZoom(zoom), fit: 'none', anchor, opening: false })),
    ),
  setFit: (docId, fit, zoom, anchor = null) =>
    set((state) => update(state, docId, (view) => ({ ...view, zoom: clampZoom(zoom), fit, anchor, opening: false }))),
  setPage: (docId, pageIndex, anchor = null) =>
    set((state) => update(state, docId, (view) => ({ ...view, pageIndex: clampPage(view, pageIndex), anchor }))),
  reportPage: (docId, pageIndex) =>
    set((state) => update(state, docId, (view) => ({ ...view, pageIndex: clampPage(view, pageIndex) }))),
  setScrollMode: (docId, mode, anchor = null, zoom) =>
    set((state) =>
      update(state, docId, (view) => ({
        ...view,
        scrollMode: mode,
        zoom: zoom === undefined ? view.zoom : clampZoom(zoom),
        anchor,
      })),
    ),
  setRotation: (docId, rotation, anchor = null, zoom) =>
    set((state) =>
      update(state, docId, (view) => ({
        ...view,
        rotation: normalizeRotation(rotation),
        zoom: zoom === undefined ? view.zoom : clampZoom(zoom),
        anchor,
      })),
    ),
  consumeAnchor: (docId) => set((state) => update(state, docId, (view) => ({ ...view, anchor: null }))),
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
