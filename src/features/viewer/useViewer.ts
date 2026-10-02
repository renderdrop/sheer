import { useEffect } from 'react';
import { create } from 'zustand';

import {
  closeDocument,
  openDocumentDialog,
  renderPage,
  type DocumentInfo,
  type OpenOutcome,
} from '../../api/documents';
import { toAppError, type AppError } from '../../api/errors';
import { DEFAULT_ZOOM, fitPageZoom, fitWidthZoom, scaleForZoom, stepZoom, wheelZoom } from '../../lib/zoom';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { useDocView, useView } from '../../stores/view';

/** A rendered page and its size in PDF points, so it can be shown at any zoom while a sharper render is in flight. */
export interface PageImage {
  url: string;
  widthPt: number;
  heightPt: number;
}

/** The canvas's content box in CSS px (its scroll region without the padding), which the fit actions fill. */
export interface Viewport {
  width: number;
  height: number;
}

/** Coalesces bursts of zoom changes (wheel, held key) into one render request. */
const RENDER_DEBOUNCE_MS = 80;

export interface ViewerState {
  /** The active document's page image, `null` until it has rendered and while there is no document. */
  image: PageImage | null;
  opening: boolean;
  rendering: boolean;
  /** The canvas's size as it last reported it, `null` until it has (and in tests that render no canvas). */
  viewport: Viewport | null;

  /** Shows the open dialog; every document that is chosen is opened and the last one becomes the active one. Never rejects. */
  open: () => Promise<void>;
  /** Closes the active document: its view and image go, and the backend is told to release it. Nothing without one. */
  close: () => void;
  /** One preset step in or out. */
  zoomStep: (direction: 1 | -1) => void;
  /** An exact zoom (the zoom menu); clamped to the zoom range. */
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
  /**
   * Zoom so the page fills the canvas's width (`fitWidth`) or fits in it whole (`fitPage`). One-shot, not a mode: a later
   * resize or page change keeps the zoom it gave. Nothing until the canvas has been measured and a page has been shown.
   */
  fitWidth: () => void;
  fitPage: () => void;
  /** Ctrl/Cmd+wheel and pinch: continuous zoom. */
  zoomByWheel: (deltaY: number, deltaMode: number) => void;
  goToPage: (pageIndex: number) => void;
  /** One page on or back; stops at the first and the last. */
  nextPage: () => void;
  previousPage: () => void;
  /** The canvas reports its size here (it observes itself). */
  setViewport: (viewport: Viewport) => void;
}

/**
 * The viewer's actions and what the canvas shows of the active document: the spike's open, render and zoom logic, moved out of
 * the shell so the layout does not depend on it. Which documents are open is the `documents` store, how each is shown (zoom,
 * page) the `view` store, a failed action the `ui` store's banner.
 *
 * It is a store, not a hook with local state, so each part of the window subscribes to the one field it shows (the canvas
 * to the image, the status bar to the name, the toolbar to whether there is a document) and a zoom step or a new page does
 * not re-render the shell around them. Every action reads the current state when it is called, so the functions are the same
 * for the life of the app and can be handed to memoized children.
 *
 * Until pages can be reordered (M3) a page id is its position, and until the viewer scrolls (M1) one page is shown.
 */
export const useViewer = create<ViewerState>()((set, get) => {
  /** Applies `change` to the view of the active document; nothing when there is none. */
  const changeView = (change: (docId: number, zoom: number) => void) => {
    const docId = useDocuments.getState().activeId;
    if (docId === null) return;
    const view = useView.getState().byDoc[docId];
    change(docId, view?.zoom ?? DEFAULT_ZOOM);
  };

  /** Moves the shown page by `delta`; the view store keeps it inside the document. */
  const changePage = (delta: number) => {
    const docId = useDocuments.getState().activeId;
    if (docId === null) return;
    const view = useView.getState().byDoc[docId];
    if (view !== undefined) useView.getState().setPage(docId, view.pageIndex + delta);
  };

  return {
    image: null,
    opening: false,
    rendering: false,
    viewport: null,

    open: async () => {
      if (get().opening) return;
      set({ opening: true });
      useUi.getState().dismissBanner();
      try {
        adoptOpenOutcomes(await openDocumentDialog());
      } catch (caught) {
        useUi.getState().showBanner(toAppError(caught));
      } finally {
        set({ opening: false });
      }
    },
    close: () => {
      const docId = useDocuments.getState().activeId;
      if (docId === null) return;
      useView.getState().close(docId);
      useDocuments.getState().remove(docId);
      // The neighbour that becomes active (if any) renders afresh; the closed document's image is not its.
      set({ image: null, rendering: false });
      closeDocument(docId).catch(() => undefined);
    },
    zoomStep: (direction) => changeView((id, zoom) => useView.getState().setZoom(id, stepZoom(zoom, direction))),
    setZoom: (zoom) => changeView((id) => useView.getState().setZoom(id, zoom)),
    resetZoom: () => changeView((id) => useView.getState().setZoom(id, DEFAULT_ZOOM)),
    fitWidth: () => {
      const { viewport, image } = get();
      const zoom = viewport === null || image === null ? null : fitWidthZoom(viewport.width, image.widthPt);
      if (zoom !== null) changeView((id) => useView.getState().setZoom(id, zoom));
    },
    fitPage: () => {
      const { viewport, image } = get();
      const zoom =
        viewport === null || image === null
          ? null
          : fitPageZoom(viewport.width, viewport.height, image.widthPt, image.heightPt);
      if (zoom !== null) changeView((id) => useView.getState().setZoom(id, zoom));
    },
    zoomByWheel: (deltaY, deltaMode) =>
      changeView((id, zoom) => useView.getState().setZoom(id, wheelZoom(zoom, deltaY, deltaMode))),
    goToPage: (pageIndex) => {
      const docId = useDocuments.getState().activeId;
      if (docId !== null) useView.getState().setPage(docId, pageIndex);
    },
    nextPage: () => changePage(1),
    previousPage: () => changePage(-1),
    setViewport: (viewport) => {
      const previous = get().viewport;
      if (previous?.width !== viewport.width || previous.height !== viewport.height) set({ viewport });
    },
  };
});

/**
 * Takes a document the backend opened into the window and makes it the active one. One that is open already (the backend
 * answers a file that is opened again with the id it has) keeps its view (zoom, page) and is only brought forward.
 */
function showDocument(info: DocumentInfo): void {
  const documents = useDocuments.getState();
  if (documents.byId[info.id] === undefined) useView.getState().open(info.id, info.pageCount);
  const changes = documents.activeId !== info.id;
  documents.add(info);
  // The image on screen is the previous document's.
  if (changes) useViewer.setState({ image: null });
}

/**
 * Takes the results of opening files into the window, from every source: the dialog's answer and what the backend pushes for
 * files dropped on the window or opened by the OS. Each opened document is added, and the last one shown. Of the failures the
 * first is shown in the banner (one banner for a drop of many files, not a stack of them); it stays until dismissed, and a
 * page that renders meanwhile does not clear it.
 */
export function adoptOpenOutcomes(outcomes: readonly OpenOutcome[]): void {
  let failure: AppError | null = null;
  for (const outcome of outcomes) {
    if (outcome.type === 'opened') showDocument(outcome.document);
    else failure ??= outcome.error;
  }
  if (failure !== null) useUi.getState().showBanner(failure);
}

/** Clears `rendering` (only when it is set, so a store that is idle does not notify anyone). */
function stopRendering(): void {
  if (useViewer.getState().rendering) useViewer.setState({ rendering: false });
}

/**
 * The error that a failed render put in the banner. A page that renders later clears that banner, and only that one: an error
 * about opening a file (a drop with a file that is not a PDF) must not vanish because the page of another document came in.
 */
let renderFailure: AppError | null = null;

function clearRenderFailure(): void {
  if (renderFailure !== null && useUi.getState().banner === renderFailure) useUi.getState().dismissBanner();
  renderFailure = null;
}

/**
 * The work that goes with the active document and has no UI of its own: it renders the current page whenever document, page
 * or zoom changes and frees the page image once it has been replaced. The keys belong to the command registry
 * (`src/actions`), not to the viewer. Mount it once (`ViewerEffects`).
 */
export function useViewerEffects(): void {
  const docId = useDocuments(selectActiveId);
  const { zoom, pageIndex, pageCount } = useDocView(docId);
  const imageUrl = useViewer((state) => state.image?.url);

  // Render the current page whenever document, page or zoom changes. Stale results are dropped.
  useEffect(() => {
    if (docId === null || pageCount === 0) {
      // Nothing to render any more, and the render that this change cancelled does not report back: it is not "rendering"
      // for ever. (A change that is followed by another render leaves the flag alone: it is still busy, and the new
      // render ends it, so the status bar does not blink in between.)
      stopRendering();
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const scale = scaleForZoom(zoom, window.devicePixelRatio);
      useViewer.setState({ rendering: true });
      renderPage(docId, pageIndex, scale)
        .then((page) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([page.data], { type: 'image/png' }));
          // `page.scale` is lower than `scale` only if the backend refused the full-size frame.
          useViewer.setState({ image: { url, widthPt: page.width / page.scale, heightPt: page.height / page.scale } });
          clearRenderFailure();
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          renderFailure = toAppError(caught);
          useUi.getState().showBanner(renderFailure);
        })
        .finally(() => {
          if (!cancelled) useViewer.setState({ rendering: false });
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [docId, pageIndex, pageCount, zoom]);

  // The hook going away cancels a render in flight the same way.
  useEffect(() => stopRendering, []);

  // Free the previous page image once it has been replaced.
  useEffect(() => {
    return () => {
      if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);
}

/** Renders nothing: it hosts `useViewerEffects` in a component of its own, so the zoom and page it follows re-render only this. */
export function ViewerEffects(): null {
  useViewerEffects();
  return null;
}
