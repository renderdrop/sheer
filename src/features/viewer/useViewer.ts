import { useEffect } from 'react';
import { create } from 'zustand';

import { closeDocument, openDocumentDialog, renderPage, type DocumentInfo } from '../../api/documents';
import { toAppError } from '../../api/errors';
import { DEFAULT_ZOOM, scaleForZoom, stepZoom, wheelZoom } from '../../lib/zoom';
import { useUi } from '../../stores/ui';
import { useDocView, useView } from '../../stores/view';

/** A rendered page and its size in PDF points, so it can be shown at any zoom while a sharper render is in flight. */
export interface PageImage {
  url: string;
  widthPt: number;
}

/** Coalesces bursts of zoom changes (wheel, held key) into one render request. */
const RENDER_DEBOUNCE_MS = 80;

export interface ViewerState {
  /** The open document, `null` while there is none. */
  doc: DocumentInfo | null;
  image: PageImage | null;
  opening: boolean;
  rendering: boolean;

  /** Shows the open dialog; a document that is chosen replaces (and closes) the one that is open. Never rejects. */
  open: () => Promise<void>;
  /** One preset step in or out. */
  zoomStep: (direction: 1 | -1) => void;
  /** An exact zoom (the zoom menu); clamped to the zoom range. */
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
  /** Ctrl/Cmd+wheel and pinch: continuous zoom. */
  zoomByWheel: (deltaY: number, deltaMode: number) => void;
  goToPage: (pageIndex: number) => void;
}

/**
 * The open document and what the canvas shows of it: the spike's open, render and zoom logic, moved out of the shell so
 * the layout does not depend on it. Zoom and page live in the `view` store, a failed action in the `ui` store's banner.
 *
 * It is a store, not a hook with local state, so each part of the window subscribes to the one field it shows (the canvas
 * to the image, the status bar to the name, the toolbar to whether there is a document) and a zoom step or a new page does
 * not re-render the shell around them. Every action reads the current state when it is called, so the functions are the same
 * for the life of the app and can be handed to memoized children.
 *
 * Until pages can be reordered (M3) a page id is its position, and until the viewer scrolls (M1) one page is shown.
 */
export const useViewer = create<ViewerState>()((set, get) => {
  /** Applies `change` to the view of the open document; nothing when there is none. */
  const changeView = (change: (docId: number, zoom: number) => void) => {
    const doc = get().doc;
    if (doc === null) return;
    const view = useView.getState().byDoc[doc.id];
    change(doc.id, view?.zoom ?? DEFAULT_ZOOM);
  };

  return {
    doc: null,
    image: null,
    opening: false,
    rendering: false,

    open: async () => {
      if (get().opening) return;
      set({ opening: true });
      useUi.getState().dismissBanner();
      try {
        const info = await openDocumentDialog();
        if (info === null) return;
        const previous = get().doc;
        useView.getState().open(info.id, info.pageCount);
        set({ doc: info, image: null });
        if (previous !== null) {
          useView.getState().close(previous.id);
          closeDocument(previous.id).catch(() => undefined);
        }
      } catch (caught) {
        useUi.getState().showBanner(toAppError(caught));
      } finally {
        set({ opening: false });
      }
    },
    zoomStep: (direction) => changeView((id, zoom) => useView.getState().setZoom(id, stepZoom(zoom, direction))),
    setZoom: (zoom) => changeView((id) => useView.getState().setZoom(id, zoom)),
    resetZoom: () => changeView((id) => useView.getState().setZoom(id, DEFAULT_ZOOM)),
    zoomByWheel: (deltaY, deltaMode) =>
      changeView((id, zoom) => useView.getState().setZoom(id, wheelZoom(zoom, deltaY, deltaMode))),
    goToPage: (pageIndex) => {
      const doc = get().doc;
      if (doc !== null) useView.getState().setPage(doc.id, pageIndex);
    },
  };
});

/** The open document's id, or `null`. A selector, so a component re-renders when the document changes and not before. */
export const selectDocId = (state: ViewerState): number | null => state.doc?.id ?? null;

/**
 * The work that goes with the open document and has no UI of its own: it renders the current page whenever document, page
 * or zoom changes, frees the page image once it has been replaced, and binds the shell's keys (Ctrl or Cmd with O, plus,
 * minus, 0) until the command registry takes that over. Mount it once (`ViewerEffects`).
 */
export function useViewerEffects(): void {
  const docId = useViewer(selectDocId);
  const { zoom, pageIndex, pageCount } = useDocView(docId);
  const imageUrl = useViewer((state) => state.image?.url);

  // Render the current page whenever document, page or zoom changes. Stale results are dropped.
  useEffect(() => {
    if (docId === null || pageCount === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const scale = scaleForZoom(zoom, window.devicePixelRatio);
      useViewer.setState({ rendering: true });
      renderPage(docId, pageIndex, scale)
        .then((page) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([page.data], { type: 'image/png' }));
          // `page.scale` is lower than `scale` only if the backend refused the full-size frame.
          useViewer.setState({ image: { url, widthPt: page.width / page.scale } });
          useUi.getState().dismissBanner();
        })
        .catch((caught: unknown) => {
          if (!cancelled) useUi.getState().showBanner(toAppError(caught));
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

  // Free the previous page image once it has been replaced.
  useEffect(() => {
    return () => {
      if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  // Keyboard: Ctrl/Cmd + O, +, -, 0. The actions never change, so the listener is bound once.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const viewer = useViewer.getState();
      switch (event.key) {
        case 'o':
        case 'O':
          event.preventDefault();
          void viewer.open();
          break;
        case '+':
        case '=':
          event.preventDefault();
          viewer.zoomStep(1);
          break;
        case '-':
        case '_':
          event.preventDefault();
          viewer.zoomStep(-1);
          break;
        case '0':
          event.preventDefault();
          viewer.resetZoom();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Renders nothing: it hosts `useViewerEffects` in a component of its own, so the zoom and page it follows re-render only this. */
export function ViewerEffects(): null {
  useViewerEffects();
  return null;
}
