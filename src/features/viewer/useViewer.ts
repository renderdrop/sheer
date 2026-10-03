import { useEffect } from 'react';
import { create } from 'zustand';

import { closeDocument, openDocumentDialog, type DocumentInfo, type OpenOutcome } from '../../api/documents';
import { toAppError, type AppError } from '../../api/errors';
import { getPageSizes } from '../../api/render';
import { announce } from '../../components';
import { tokenPx } from '../../components/tokens';
import { renderScheduler } from '../../engine/renderScheduler';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import { DEFAULT_ZOOM, clampZoom, wheelFactor } from '../../lib/zoom';
import { useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { useUi } from '../../stores/ui';
import { useView, type DocView } from '../../stores/view';
import {
  anchorAt,
  centeredScroll,
  fitZoomFor,
  pageStep,
  pageTopAnchor,
  scrollFor,
  type ScrollAnchor,
  type ScrollMode,
  type Viewport,
} from './layout';
import { requestPassword } from '../password/state';
import { layoutFor, metricsOfDocument, pageGap } from './model';
import type { ViewportAnchor } from './Canvas';
import { beginOpening, forgetOpening } from './openTransition';
import { markJump, readScroll } from './scrollBridge';
import { addRotation, type Rotation } from './transform';
import { animationsOff, createZoomMotion, zoomContent, type ZoomMotion, type ZoomPoint } from './zoomMotion';

export type { Viewport } from './layout';

/**
 * Where a zoom gesture is centred: a position in the viewport in px (the scroll region's content box), the pointer for a wheel or a
 * pinch. Without one the middle of the viewport is the centre (the zoom buttons, the keys, the zoom menu).
 */
export type ZoomFocus = ZoomPoint;

/** A Ctrl/Cmd+wheel event this large (or counted in lines) is a notch of a mouse wheel: one step. A trackpad pinch sends small deltas. */
const WHEEL_NOTCH_PX = 50;

/** The zoom motion of the running viewer: the canvas asks it to drop its transform once the committed layout is in the DOM. */
let motionInUse: ZoomMotion | null = null;

/** Drops a zoom in flight without committing it (document switch, canvas unmount). */
export function cancelZoomMotion(): void {
  motionInUse?.cancel();
}

export function settleZoomMotion(): void {
  motionInUse?.settle();
}

/** A render has to last this long to be shown as activity: most are over in a few milliseconds and would only make the status bar blink. */
const RENDERING_SHOWN_AFTER_MS = 250;

export interface ViewerState {
  opening: boolean;
  /** A render is in flight (and has been for a moment): the status bar says so. */
  rendering: boolean;
  /** The canvas's size as it last reported it, `null` until it has (and in tests that render no canvas). */
  viewport: Viewport | null;

  /** Shows the open dialog; every document that is chosen is opened and the last one becomes the active one. Never rejects. */
  open: () => Promise<void>;
  /** Closes the active document: its view, pages and images go, and the backend is told to release it. Nothing without one. */
  close: () => void;
  /** One preset step in or out. */
  zoomStep: (direction: 1 | -1) => void;
  /** An exact zoom (the zoom menu); clamped to the zoom range. Ends a fit. */
  setZoom: (zoom: number) => void;
  /** 100 %. */
  resetZoom: () => void;
  /**
   * Zoom so the current page fills the canvas's width (`fitWidth`) or fits in it whole (`fitPage`; a spread fits both pages). It
   * stays fitted as the window is resized until the next zoom of any other kind. Nothing until the canvas has been measured.
   */
  fitWidth: () => void;
  fitPage: () => void;
  /** Ctrl/Cmd+wheel: continuous zoom around the pointer (`focus`). */
  zoomByWheel: (deltaY: number, deltaMode: number, focus?: ZoomFocus) => void;
  /** Multiplies the zoom by `factor`, around `focus`: a trackpad pinch that arrives as gesture events. */
  zoomBy: (factor: number, focus?: ZoomFocus) => void;
  /** Continuous scrolling, one page at a time, or two pages side by side; the current page stays in view. */
  setScrollMode: (mode: ScrollMode) => void;
  goToPage: (pageIndex: number) => void;
  /** Turns every page of the active document by `degrees` (a multiple of 90; view only, DESIGN 3.20), keeping the reading position. */
  rotateView: (degrees: number) => void;
  /** Back to the file's own orientation. */
  resetRotation: () => void;
  /** Shows the point `yPt` (points from the top of the page's box) of a page at the canvas's top padding; the outline's jump. */
  goToPoint: (pageIndex: number, yPt: number) => void;
  /** One page on (a spread on, in the two-page mode) or back; stops at the first and the last. */
  nextPage: () => void;
  previousPage: () => void;
  /** The canvas reports its size here (it observes itself). A fit follows it. */
  setViewport: (viewport: Viewport, anchor?: ViewportAnchor) => void;
}

/**
 * The viewer's actions and what the canvas needs of the active document that is not in another store: whether a render is in
 * flight and how big the canvas is. Which documents are open is the `documents` store, how each is shown (zoom, fit, mode, page)
 * the `view` store, the page sizes the `pages` store, the pixels the render cache (`src/engine`), a failed action the `ui`
 * store's banner.
 *
 * It is a store, not a hook with local state, so each part of the window subscribes to the one field it shows (the canvas to its
 * size, the status bar to whether a render runs, the toolbar to whether there is a document) and a zoom step or a new page does
 * not re-render the shell around them. Every action reads the current state when it is called, so the functions are the same for
 * the life of the app and can be handed to memoized children.
 *
 * Until pages can be reordered (M3) a page id is its position.
 */
export const useViewer = create<ViewerState>()((set, get) => {
  /** The active document and its view; `null` while none is open. */
  const active = (): { docId: number; view: DocView } | null => {
    const docId = useDocuments.getState().activeId;
    if (docId === null) return null;
    const view = useView.getState().byDoc[docId];
    return view === undefined ? null : { docId, view };
  };

  /**
   * The anchor that keeps the document point at `focus` (the middle of the viewport by default) where it is while the layout
   * changes. The scroll position is the canvas's, unless a request to scroll is still waiting there (two zoom steps before the
   * canvas laid itself out for the first): then it is where that one will put it.
   */
  const anchorFor = (docId: number, focus?: ZoomFocus): ScrollAnchor | null => {
    const { viewport } = get();
    const layout = layoutFor(docId, viewport);
    if (layout === null || viewport === null) return null;
    const pending = useView.getState().byDoc[docId]?.anchor ?? null;
    const scroll = pending === null ? readScroll() : scrollFor(layout, pending);
    return anchorAt(layout, scroll, focus?.x ?? viewport.width / 2, focus?.y ?? viewport.height / 2);
  };

  const zoomTo = (zoom: number, focus?: ZoomFocus) => {
    const current = active();
    if (current === null) return;
    const next = clampZoom(zoom);
    if (next === current.view.zoom && current.view.fit === 'none') return;
    useView.getState().setZoom(current.docId, next, anchorFor(current.docId, focus));
  };

  /** The zoom of a fit of the current page, `null` until the canvas and the page sizes are known. */
  const fitZoom = (fit: 'width' | 'page'): number | null => {
    const current = active();
    const { viewport } = get();
    if (current === null || viewport === null) return null;
    const metrics = metricsOfDocument(current.docId);
    return metrics === null ? null : fitZoomFor(fit, metrics, current.view.pageIndex, viewport, pageGap());
  };

  /** Makes a fit real. Fitting the page shows it from its top; fitting the width keeps what is around `focus`. */
  const applyFit = (fit: 'width' | 'page', zoom: number, focus?: ZoomFocus) => {
    const current = active();
    const { viewport } = get();
    if (current === null || viewport === null) return;
    const layout = layoutFor(current.docId, viewport, { zoom: clampZoom(zoom) });
    const anchor =
      fit === 'page' && layout !== null
        ? pageTopAnchor(layout, current.view.pageIndex, centeredScroll(layout))
        : anchorFor(current.docId, focus);
    useView.getState().setFit(current.docId, fit, zoom, anchor);
  };

  /** The zoom's motion (MOTION 4.4): the canvas content is scaled while it runs, and this is called once, at rest. */
  const motion = createZoomMotion({
    zoom: () => active()?.view.zoom ?? DEFAULT_ZOOM,
    fitStops: () => ({ width: fitZoom('width'), page: fitZoom('page') }),
    commit: (zoom, fit, focus) => {
      if (fit === 'none') zoomTo(zoom, focus);
      else applyFit(fit, zoom, focus);
    },
    content: zoomContent,
    scroll: readScroll,
    center: () => motionCenter(),
    reduced: () =>
      animationsOff() ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  });
  motionInUse = motion;

  const fitTo = (fit: 'width' | 'page') => {
    const zoom = fitZoom(fit);
    if (zoom !== null) motion.animateTo(zoom, fit, 'slow');
  };

  /** Shows `pageIndex` (clamped) at the top of the viewport. Does nothing for a number that is not one. */
  const goTo = (pageIndex: number) => {
    const current = active();
    if (current === null || !Number.isFinite(pageIndex)) return;
    const target = Math.min(Math.max(0, current.view.pageCount - 1), Math.max(0, Math.trunc(pageIndex)));
    const layout = layoutFor(current.docId, get().viewport, { current: target });
    const anchor = layout === null ? null : pageTopAnchor(layout, target, readScroll());
    markJump();
    useView.getState().setPage(current.docId, target, anchor);
  };

  /** Like `goTo`, to a point of the page: it lands 24 px (`--space-3`) below the viewport's top (the canvas's `scroll-padding-top`). */
  const goToPoint = (pageIndex: number, yPt: number) => {
    const current = active();
    if (current === null || !Number.isFinite(pageIndex)) return;
    if (!Number.isFinite(yPt) || yPt <= 0) {
      goTo(pageIndex);
      return;
    }
    const target = Math.min(Math.max(0, current.view.pageCount - 1), Math.max(0, Math.trunc(pageIndex)));
    const layout = layoutFor(current.docId, get().viewport, { current: target });
    const top = layout === null ? null : pageTopAnchor(layout, target, readScroll());
    const box = layout?.box(target) ?? null;
    // A y beyond the page (a hostile file) stays on the page: it never scrolls into the next one.
    const heightPt = box === null || layout === null ? yPt : box.height / layout.scale;
    const anchor = top === null ? null : { ...top, yPt: Math.min(yPt, heightPt), viewY: tokenPx('--space-3', 24) };
    markJump();
    useView.getState().setPage(current.docId, target, anchor);
  };

  const turn = (direction: 1 | -1) => {
    const current = active();
    if (current === null) return;
    const step = pageStep(current.view.scrollMode);
    const target = Math.min(
      Math.max(0, current.view.pageCount - 1),
      Math.max(0, current.view.pageIndex + direction * step),
    );
    // At the first or the last page there is nowhere to turn to: the page is not snapped back to its top.
    if (target !== current.view.pageIndex) goTo(target);
  };

  /** Rotates the view and keeps the page the reader is on at the top; a fit is made again for the turned pages. */
  const turnTo = (rotation: Rotation) => {
    const current = active();
    if (current === null || current.view.rotation === rotation) return;
    const { viewport } = get();
    const metrics = metricsOfDocument(current.docId, undefined, rotation);
    const refit =
      current.view.fit === 'none' || metrics === null || viewport === null
        ? null
        : fitZoomFor(current.view.fit, metrics, current.view.pageIndex, viewport, pageGap());
    const layout = layoutFor(current.docId, viewport, {
      rotation,
      zoom: refit === null ? undefined : clampZoom(refit),
    });
    const anchor = layout === null ? null : pageTopAnchor(layout, current.view.pageIndex, centeredScroll(layout));
    useView.getState().setRotation(current.docId, rotation, anchor, refit ?? undefined);
    announce(translators[useLocaleStore.getState().locale]('rotate.announce', { deg: rotation }));
  };

  const motionCenter = (): ZoomFocus => {
    const { viewport } = get();
    return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
  };

  return {
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
      forgetOpening(docId);
      useView.getState().close(docId);
      useAnnotations.getState().remove(docId);
      useDocuments.getState().remove(docId);
      usePages.getState().remove(docId);
      // Its images go, and what is still on its way is dropped when it arrives.
      renderScheduler.dropDocument(docId);
      // The UI decided (it asked about unsaved changes before): the backend need not.
      closeDocument(docId, true).catch(() => undefined);
    },
    zoomStep: (direction) => {
      if (active() !== null) motion.step(direction);
    },
    setZoom: (zoom) => {
      if (active() !== null) motion.animateTo(zoom, 'none', 'base');
    },
    resetZoom: () => {
      if (active() !== null) motion.animateTo(DEFAULT_ZOOM, 'none', 'slow');
    },
    fitWidth: () => fitTo('width'),
    fitPage: () => fitTo('page'),
    zoomByWheel: (deltaY, deltaMode, focus) => {
      if (active() === null) return;
      if (deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH_PX) {
        if (deltaY !== 0) motion.step(deltaY < 0 ? 1 : -1, focus);
        return;
      }
      get().zoomBy(wheelFactor(deltaY, deltaMode), focus);
    },
    zoomBy: (factor, focus) => {
      if (active() !== null && Number.isFinite(factor) && factor > 0) motion.gesture(factor, focus ?? motionCenter());
    },
    setScrollMode: (mode) => {
      const current = active();
      if (current === null || current.view.scrollMode === mode) return;
      const { viewport } = get();
      // A fit depends on the mode (a spread is two pages wide), so it is made again for the new one.
      const metrics = metricsOfDocument(current.docId, mode);
      const refit =
        current.view.fit === 'none' || metrics === null || viewport === null
          ? null
          : fitZoomFor(current.view.fit, metrics, current.view.pageIndex, viewport, pageGap());
      const layout = layoutFor(current.docId, viewport, { mode, zoom: refit === null ? undefined : clampZoom(refit) });
      const anchor = layout === null ? null : pageTopAnchor(layout, current.view.pageIndex, centeredScroll(layout));
      useView.getState().setScrollMode(current.docId, mode, anchor, refit ?? undefined);
    },
    goToPage: goTo,
    rotateView: (degrees) => {
      const current = active();
      if (current === null || !Number.isFinite(degrees)) return;
      turnTo(addRotation(current.view.rotation, degrees));
    },
    resetRotation: () => turnTo(0),
    goToPoint,
    nextPage: () => turn(1),
    previousPage: () => turn(-1),
    setViewport: (viewport, kept) => {
      const previous = get().viewport;
      if (previous?.width === viewport.width && previous.height === viewport.height) return;
      // A fit follows the window: the zoom is computed for the new size, around what is at the top left of the viewport now.
      const current = active();
      let refit: { fit: 'width' | 'page'; zoom: number; anchor: ScrollAnchor | null } | null = null;
      if (current !== null && current.view.fit !== 'none') {
        const metrics = metricsOfDocument(current.docId);
        const zoom =
          metrics === null ? null : fitZoomFor(current.view.fit, metrics, current.view.pageIndex, viewport, pageGap());
        if (zoom !== null && Math.abs(zoom - current.view.zoom) > 1e-9) {
          const before = layoutFor(current.docId, previous);
          refit = {
            fit: current.view.fit,
            zoom,
            anchor: before === null ? null : anchorAt(before, readScroll(), 0, 0),
          };
        }
      }
      // The size that ends a slide of the panels keeps the content point the canvas says is where the user was looking.
      if (kept !== undefined && current !== null) {
        const before = layoutFor(current.docId, previous);
        const found = before === null ? null : anchorAt(before, { left: 0, top: 0 }, kept.x, kept.y);
        const anchor = found === null ? null : { ...found, viewX: kept.viewX, viewY: kept.viewY };
        if (refit !== null) refit.anchor = anchor;
        else {
          set({ viewport });
          const { fit, zoom } = current.view;
          if (fit === 'none') useView.getState().setZoom(current.docId, zoom, anchor);
          else useView.getState().setFit(current.docId, fit, zoom, anchor);
          return;
        }
      }
      set({ viewport });
      if (current !== null && refit !== null)
        useView.getState().setFit(current.docId, refit.fit, refit.zoom, refit.anchor);
    },
  };
});

/** Fetches the sizes of a document's pages for the layout. A failure is shown; the canvas keeps laying out placeholders. */
function loadPageSizes(docId: number): void {
  getPageSizes(docId).then(
    (sizes) => {
      // The document may have been closed while the answer was on its way.
      if (useDocuments.getState().byId[docId] !== undefined) usePages.getState().set(docId, sizes);
    },
    (caught: unknown) => {
      if (useDocuments.getState().byId[docId] === undefined) return;
      // Without sizes the canvas never decides the opening zoom: the readouts show the zoom the view has.
      useView.getState().settleOpening(docId);
      useUi.getState().showBanner(toAppError(caught));
    },
  );
}

/**
 * Takes a document the backend opened into the window and makes it the active one. One that is open already (the backend
 * answers a file that is opened again with the id it has) keeps its view (zoom, page) and is only brought forward.
 */
function showDocument(info: DocumentInfo): void {
  const documents = useDocuments.getState();
  const isNew = documents.byId[info.id] === undefined;
  if (isNew) {
    useView.getState().open(info.id, info.pageCount, true);
    renderScheduler.cache.admit(info.id);
  }
  documents.add(info);
  if (isNew) {
    beginOpening(info.id);
    loadPageSizes(info.id);
  }
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
    else if (outcome.type === 'needsPassword') requestPassword(outcome.id, outcome.displayName);
    else failure ??= outcome.error;
  }
  if (failure !== null) useUi.getState().showBanner(failure);
}

/** Clears `rendering` (only when it is set, so a store that is idle does not notify anyone). */
function stopRendering(): void {
  if (useViewer.getState().rendering) useViewer.setState({ rendering: false });
}

/**
 * The work that goes with the viewer and has no UI of its own: it mirrors "the render scheduler has requests in flight" into
 * `rendering`, which the status bar shows. The keys belong to the command registry (`src/actions`), not to the viewer, and the
 * pages ask for their own images (`PageView`). Mount it once (`ViewerEffects`).
 */
export function useViewerEffects(): void {
  useEffect(() => {
    let timer: number | undefined;
    const follow = (busy: boolean) => {
      window.clearTimeout(timer);
      if (busy) {
        timer = window.setTimeout(() => {
          if (renderScheduler.busy) useViewer.setState({ rendering: true });
        }, RENDERING_SHOWN_AFTER_MS);
      } else {
        stopRendering();
      }
    };
    follow(renderScheduler.busy);
    const stop = renderScheduler.onBusy(follow);
    return () => {
      stop();
      window.clearTimeout(timer);
      stopRendering();
    };
  }, []);
}

/** Renders nothing: it hosts `useViewerEffects` in a component of its own. */
export function ViewerEffects(): null {
  useViewerEffects();
  return null;
}
